/**
 * Capture an immutable inventory-valuation snapshot for both warehouses.
 *
 * The primary use is the CUTOVER ANCHOR: run this once, right after a clean cost
 * sync, to freeze "as of now, the warehouses were worth X at the costs we know
 * today". That row becomes the first trustworthy boundary the Supply Chain
 * report and future month-closes can lean on, instead of every past number
 * moving whenever costs change again.
 *
 * Also usable to capture a specific past instant (AS_OF) — quantities are
 * reconstructed exactly; note that unit costs are CURRENT (we can't retro-price
 * without full historical cost coverage), which is honest for an anchor but not
 * an exact historical valuation. The snapshot's cost_basis records this.
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/capture-inventory-valuation-snapshot.ts
 *
 *   TYPE=cutover_anchor   (default) | month_close | manual
 *   AS_OF=2026-07-01T03:59:59Z   instant to value (default: now)
 *   NOTE="July cutover"          free-text stored on the header
 *   WAREHOUSE=miami|china|both   (default both)
 *   DRY_RUN=true                 reconstruct + print totals, write nothing
 */

import {
  captureInventoryValuationSnapshot,
  type Warehouse,
  type SnapshotType,
} from "../../lib/cost/inventory-snapshot";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
  transaction?: () => Promise<any>;
};

const VALID_TYPES: SnapshotType[] = ["cutover_anchor", "month_close", "manual", "nightly"];

export default async function captureSnapshot({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as Knex;

  const type = (process.env.TYPE ?? "cutover_anchor") as SnapshotType;
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`TYPE inválido: ${type}. Usá uno de ${VALID_TYPES.join(", ")}.`);
  }
  const asOf = process.env.AS_OF || undefined;
  const note = process.env.NOTE || undefined;
  const dryRun = process.env.DRY_RUN === "true";
  const which = (process.env.WAREHOUSE ?? "both").toLowerCase();
  const warehouses: Warehouse[] =
    which === "miami" ? ["miami"] : which === "china" ? ["china"] : ["miami", "china"];

  console.log(
    `📸 Inventory valuation snapshot — type=${type} asOf=${asOf ?? "now"}` +
      `${dryRun ? " [DRY RUN]" : ""} warehouses=${warehouses.join(",")}`
  );

  if (dryRun) {
    // Reconstruct + total without writing, so the anchor can be eyeballed first.
    for (const warehouse of warehouses) {
      const preview = await captureInDryRun(knex, warehouse, asOf);
      console.log(
        `   ${warehouse.padEnd(6)} → ${preview.lines} lines · ${preview.units} units · ` +
          `$${(preview.valueCents / 100).toFixed(2)}`
      );
    }
    console.log("DRY RUN — nothing written.");
    return;
  }

  for (const warehouse of warehouses) {
    const r = await captureInventoryValuationSnapshot(knex, {
      warehouse,
      asOf,
      snapshotType: type,
      note,
    });
    console.log(
      `   ✅ ${warehouse.padEnd(6)} → ${r.snapshotId} · ${r.variantCount} lines · ` +
        `${r.totalQuantity} units · $${(r.totalValueCents / 100).toFixed(2)}`
    );
  }
  console.log("Done.");
}

// Same reconstruction as the real capture, summed instead of stored — used only
// for the DRY_RUN preview so nothing hits the tables.
async function captureInDryRun(
  knex: Knex,
  warehouse: Warehouse,
  asOf?: string
): Promise<{ lines: number; units: number; valueCents: number }> {
  // Reuse the real capture inside a rolled-back transaction: identical code
  // path, zero divergence risk, and it writes nothing.
  const trx = knex.transaction ? await knex.transaction() : null;
  const run = (trx ?? knex) as Knex;
  try {
    const r = await captureInventoryValuationSnapshot(run, {
      warehouse,
      asOf,
      snapshotType: "manual",
      note: "dry-run preview (rolled back)",
    });
    await trx?.rollback();
    return { lines: r.variantCount, units: r.totalQuantity, valueCents: r.totalValueCents };
  } catch (error) {
    await trx?.rollback().catch(() => {});
    throw error;
  }
}
