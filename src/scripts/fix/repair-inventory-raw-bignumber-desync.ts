/**
 * src/scripts/fix/repair-inventory-raw-bignumber-desync.ts
 *
 * Repairs rows where the plain numeric column and its `raw_*` JSONB BigNumber
 * mirror diverged. Medusa's ORM reads the raw_* column, so a raw-SQL writer that
 * only touched the numeric column (historically: the China transfer decrement in
 * `lib/inventory-transfer-link.ts`) leaves Medusa — and therefore MeiliSearch —
 * reading the STALE raw value. This shows up as phantom China stock in the POS.
 *
 * Truth = the numeric column (that is what the raw-SQL writers correctly updated).
 * We set raw_* := numeric for every diverged pair, then re-sync the affected
 * inventory items to MeiliSearch so the index reflects the repaired truth.
 *
 * Covers all three inventory_level pairs (stocked / reserved / incoming) at BOTH
 * locations, plus reservation_item.quantity ↔ raw_quantity.
 *
 * Dry-run (default):
 *   env DATABASE_URL=... yarn medusa exec ./src/scripts/fix/repair-inventory-raw-bignumber-desync.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=... yarn medusa exec ./src/scripts/fix/repair-inventory-raw-bignumber-desync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

interface KnexRaw {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

interface DivergedLevelRow {
  inventory_item_id: string;
  location_id: string;
  field: string;
  numeric_value: string;
  raw_value: string;
}

const PAIRS = [
  { numeric: "stocked_quantity", raw: "raw_stocked_quantity" },
  { numeric: "reserved_quantity", raw: "raw_reserved_quantity" },
  { numeric: "incoming_quantity", raw: "raw_incoming_quantity" },
];

export default async function repairRawDesync({ container }: ExecArgs) {
  const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as unknown as KnexRaw;

  logger.info(
    `\n=== repair-inventory-raw-bignumber-desync (${APPLY ? "APPLY" : "DRY-RUN"}) ===`
  );

  // 1. inventory_level: detect every diverged numeric↔raw pair.
  const diverged: DivergedLevelRow[] = [];
  for (const pair of PAIRS) {
    const res = await knex.raw(
      `SELECT inventory_item_id, location_id,
              '${pair.numeric}' AS field,
              ${pair.numeric}::text AS numeric_value,
              (${pair.raw}->>'value') AS raw_value
         FROM inventory_level
        WHERE deleted_at IS NULL
          AND ${pair.numeric} <> (${pair.raw}->>'value')::numeric`
    );
    diverged.push(...(res.rows as DivergedLevelRow[]));
  }

  logger.info(`inventory_level diverged pairs: ${diverged.length}`);
  for (const d of diverged.slice(0, 60)) {
    logger.info(
      `  ${d.field}  item=${d.inventory_item_id} loc=${d.location_id} numeric=${d.numeric_value} raw=${d.raw_value}`
    );
  }
  if (diverged.length > 60)
    logger.info(`  … +${diverged.length - 60} more`);

  // 2. reservation_item quantity ↔ raw_quantity divergence.
  const resDiverged = (
    await knex.raw(
      `SELECT id, inventory_item_id, quantity::text AS numeric_value,
              (raw_quantity->>'value') AS raw_value
         FROM reservation_item
        WHERE deleted_at IS NULL
          AND quantity <> (raw_quantity->>'value')::numeric`
    )
  ).rows as Array<{
    id: string;
    inventory_item_id: string;
    numeric_value: string;
    raw_value: string;
  }>;
  logger.info(`reservation_item diverged: ${resDiverged.length}`);

  const affectedItemIds = new Set<string>();
  diverged.forEach((d) => affectedItemIds.add(d.inventory_item_id));
  resDiverged.forEach((r) => affectedItemIds.add(r.inventory_item_id));

  if (!APPLY) {
    logger.info(
      `\nDRY-RUN: would repair ${diverged.length} level pair(s) + ${resDiverged.length} reservation(s), then re-sync ${affectedItemIds.size} item(s) to MeiliSearch. Re-run with APPLY=1.`
    );
    return;
  }

  // 3. Apply: set raw_* := numeric for every diverged inventory_level pair.
  for (const pair of PAIRS) {
    const upd = await knex.raw(
      `UPDATE inventory_level
          SET ${pair.raw} = jsonb_build_object(
                'value', ${pair.numeric}::text, 'precision', 20
              ),
              updated_at = NOW()
        WHERE deleted_at IS NULL
          AND ${pair.numeric} <> (${pair.raw}->>'value')::numeric`
    );
    logger.info(`repaired ${pair.raw}: ${upd.rowCount ?? 0} row(s)`);
  }

  // 4. reservation_item raw_quantity := quantity.
  const resUpd = await knex.raw(
    `UPDATE reservation_item
        SET raw_quantity = jsonb_build_object('value', quantity::text, 'precision', 20),
            updated_at = NOW()
      WHERE deleted_at IS NULL
        AND quantity <> (raw_quantity->>'value')::numeric`
  );
  logger.info(`repaired reservation_item.raw_quantity: ${resUpd.rowCount ?? 0}`);

  // 5. Re-sync affected items to MeiliSearch so the index reflects truth.
  let synced = 0;
  for (const inventoryItemId of affectedItemIds) {
    try {
      await syncInventoryItemToMeiliSearchWorkflow(container).run({
        input: { inventoryItemId },
      });
      synced++;
    } catch (e) {
      logger.warn(
        `meili resync failed for ${inventoryItemId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  logger.info(`\n✅ Done. Re-synced ${synced}/${affectedItemIds.size} items to MeiliSearch.`);
}
