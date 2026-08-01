/**
 * verify-inventory-count-item-exclusivity.ts
 *
 * Gate for the inventory-count item-claim invariant:
 *
 *   At most one unresolved count line may hold the right to apply a correction
 *   for a given (inventory_item_id, stock_location_id).
 *
 * WHY THIS EXISTS
 *   A count freezes delta_original at submit and applies it against LIVE stock
 *   at approve. That survives real stock movement but NOT a second correction of
 *   the same discrepancy: both counts measure the whole gap and each applies it
 *   in full, so stock lands double-corrected and QuickBooks books the same
 *   shrinkage twice.
 *
 * HOW TO RUN (plain tsx — this is NOT a `medusa exec` script; those export
 * default and silently do nothing under tsx, exiting 0)
 *
 *   cd backend
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-inventory-count-item-exclusivity.ts
 *
 *   Sandbox:
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-inventory-count-item-exclusivity.ts
 *
 * WHAT IS A FAILURE VS WHAT IS NOT
 *   FAIL  = the claim table drifted from the lifecycle: a claim survived a
 *           terminal transition, points at a resolved line, points at nothing,
 *           or an armed line holds no claim at all (nothing stops a second
 *           count from arming the same item).
 *   REPORT= an armed line whose item is legitimately claimed by ANOTHER count.
 *           That is the guard doing its job on data that predates it: the count
 *           will be refused at approve until a human resolves it. Listed by
 *           name, never counted as a failure, because it is the intended
 *           fail-closed state and a gate that is always red gets ignored.
 */

import knexFactory from "knex";

const ARMED_LINE_STATUSES = ["pending", "blocked"];
const ARMED_COUNT_STATUSES = ["submitted", "partially_applied"];

const connection = process.env.DATABASE_URL;
if (!connection) {
  console.error(
    "DATABASE_URL is required. See the header of this file for the exact command."
  );
  process.exit(2);
}

const knex = knexFactory({ client: "pg", connection });

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];

function fail(check: string, detail: string): void {
  failures.push({ check, detail });
}

async function main(): Promise<void> {
  console.log("\n=== inventory count · item exclusivity ===\n");

  const target = connection!.includes("localhost:5499")
    ? "SANDBOX"
    : "PRODUCTION (read-only)";
  console.log(`target: ${target}\n`);

  // ── 1. Claims pointing at a count that no longer exists ────────────────────
  const orphanCounts = await knex("inventory_count_item_claim as c")
    .leftJoin("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .whereNull("ic.id")
    .select("c.inventory_item_id", "c.inventory_count_id");

  if (orphanCounts.length > 0) {
    fail(
      "orphan_claim_count",
      `${orphanCounts.length} claim(s) point at a count row that does not exist: ` +
        orphanCounts
          .slice(0, 5)
          .map((r) => `${r.inventory_item_id}->${r.inventory_count_id}`)
          .join(", ")
    );
  }
  console.log(`1. claims sin count           ${orphanCounts.length === 0 ? "OK" : "FAIL"}`);

  // ── 2. Claims held by a count in a terminal state ──────────────────────────
  // Release runs on approve / reject / void / cancel. A survivor here means one
  // of those paths forgot, and the item is locked with nothing able to free it.
  const terminalHolders = await knex("inventory_count_item_claim as c")
    .join("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .whereNotIn("ic.status", ARMED_COUNT_STATUSES)
    .select("ic.number", "ic.status", "c.inventory_item_id");

  if (terminalHolders.length > 0) {
    fail(
      "claim_held_by_terminal_count",
      `${terminalHolders.length} claim(s) still held by a non-armed count: ` +
        terminalHolders
          .slice(0, 5)
          .map((r) => `${r.number ?? "?"}[${r.status}]`)
          .join(", ")
    );
  }
  console.log(
    `2. claims de count terminal   ${terminalHolders.length === 0 ? "OK" : "FAIL"}`
  );

  // ── 3. Claims pointing at a line that is already resolved ──────────────────
  const resolvedLineHolders = await knex("inventory_count_item_claim as c")
    .join("inventory_count_line as icl", "icl.id", "c.inventory_count_line_id")
    .whereNotIn("icl.status", ARMED_LINE_STATUSES)
    .select("icl.sku", "icl.status", "c.inventory_count_id");

  if (resolvedLineHolders.length > 0) {
    fail(
      "claim_on_resolved_line",
      `${resolvedLineHolders.length} claim(s) point at a resolved line: ` +
        resolvedLineHolders
          .slice(0, 5)
          .map((r) => `${r.sku}[${r.status}]`)
          .join(", ")
    );
  }
  console.log(
    `3. claims de linea resuelta   ${resolvedLineHolders.length === 0 ? "OK" : "FAIL"}`
  );

  // ── 4. Claim key must match the line it points at ──────────────────────────
  // Catches a claim written with the wrong item or the wrong location, which
  // would lock one SKU while leaving the real one free.
  const mismatched = await knex("inventory_count_item_claim as c")
    .join("inventory_count_line as icl", "icl.id", "c.inventory_count_line_id")
    .join("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .where((qb) =>
      qb
        .whereRaw("c.inventory_item_id <> icl.inventory_item_id")
        .orWhereRaw("c.stock_location_id <> ic.stock_location_id")
    )
    .select("icl.sku", "c.inventory_item_id", "c.stock_location_id");

  if (mismatched.length > 0) {
    fail(
      "claim_key_mismatch",
      `${mismatched.length} claim(s) whose key does not match their line/count: ` +
        mismatched.slice(0, 5).map((r) => r.sku).join(", ")
    );
  }
  console.log(`4. clave de claim coherente   ${mismatched.length === 0 ? "OK" : "FAIL"}`);

  // ── 5. Every armed line must be covered by a claim ─────────────────────────
  // Either its own count holds it (normal) or another count does (blocked by
  // design, reported below). A line covered by NEITHER is armed and loose:
  // nothing prevents a second count from arming the same item.
  const armedLines: Array<{
    line_id: string;
    sku: string;
    inventory_item_id: string;
    stock_location_id: string;
    count_id: string;
    number: string | null;
  }> = await knex("inventory_count_line as icl")
    .join("inventory_count as ic", "ic.id", "icl.inventory_count_id")
    .whereNull("ic.deleted_at")
    .whereNull("icl.deleted_at")
    .whereNull("ic.voided_at")
    .whereIn("ic.status", ARMED_COUNT_STATUSES)
    .whereIn("icl.status", ARMED_LINE_STATUSES)
    .select(
      "icl.id as line_id",
      "icl.sku",
      "icl.inventory_item_id",
      "ic.stock_location_id",
      "ic.id as count_id",
      "ic.number"
    );

  const claims: Array<{
    inventory_item_id: string;
    stock_location_id: string;
    inventory_count_id: string;
    number: string | null;
  }> = await knex("inventory_count_item_claim as c")
    .leftJoin("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .select(
      "c.inventory_item_id",
      "c.stock_location_id",
      "c.inventory_count_id",
      "ic.number"
    );

  const claimByKey = new Map<string, (typeof claims)[number]>();
  for (const c of claims) {
    claimByKey.set(`${c.inventory_item_id}|${c.stock_location_id}`, c);
  }

  const uncovered: string[] = [];
  const blockedByDesign: string[] = [];

  for (const line of armedLines) {
    const key = `${line.inventory_item_id}|${line.stock_location_id}`;
    const owner = claimByKey.get(key);
    if (!owner) {
      uncovered.push(`${line.sku} (${line.number ?? line.count_id})`);
    } else if (owner.inventory_count_id !== line.count_id) {
      blockedByDesign.push(
        `${line.sku}: ${line.number ?? line.count_id} blocked by ${
          owner.number ?? owner.inventory_count_id
        }`
      );
    }
  }

  if (uncovered.length > 0) {
    fail(
      "armed_line_without_claim",
      `${uncovered.length} armed line(s) hold no claim at all: ` +
        uncovered.slice(0, 8).join(", ")
    );
  }
  console.log(`5. lineas armadas cubiertas   ${uncovered.length === 0 ? "OK" : "FAIL"}`);

  // ── 6. Approvals stuck in flight ──────────────────────────────────────────
  // `approving_started_at` is the approve-time mutex. Every exit path clears it,
  // so a stamp older than a few minutes means a request died mid-approval and
  // left the line unapprovable — it fails CLOSED (nothing corrupts) but nobody
  // can move that count forward until someone clears it.
  const stuck = await knex("inventory_count_item_claim as c")
    .leftJoin("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .whereNotNull("c.approving_started_at")
    .andWhereRaw("c.approving_started_at < now() - interval '15 minutes'")
    .select("ic.number", "c.inventory_item_id", "c.approving_started_at");

  if (stuck.length > 0) {
    fail(
      "approval_stuck_in_flight",
      `${stuck.length} claim(s) stamped as approving for over 15 min ` +
        `(clear with: UPDATE inventory_count_item_claim SET approving_started_at = NULL ` +
        `WHERE inventory_count_id = '<id>'): ` +
        stuck.slice(0, 5).map((r) => `${r.number ?? "?"}`).join(", ")
    );
  }
  console.log(`6. approvals colgados         ${stuck.length === 0 ? "OK" : "FAIL"}`);

  // ── Report (not a failure) ────────────────────────────────────────────────
  console.log(`\nlineas armadas: ${armedLines.length} · claims: ${claims.length}`);

  if (blockedByDesign.length > 0) {
    console.log(
      `\nBLOQUEADAS POR DISENO (${blockedByDesign.length}) — el guard las va a ` +
        `rechazar en el approve hasta que una persona decida cual cuenta vale:`
    );
    for (const b of blockedByDesign.slice(0, 20)) console.log(`  · ${b}`);
    if (blockedByDesign.length > 20) {
      console.log(`  … y ${blockedByDesign.length - 20} mas`);
    }
  }

  console.log("");
  if (failures.length === 0) {
    console.log("PASS — la exclusividad por item se sostiene\n");
    await knex.destroy();
    process.exit(0);
  }

  console.log(`FAIL — ${failures.length} invariante(s) rota(s):\n`);
  for (const f of failures) console.log(`  [${f.check}] ${f.detail}`);
  console.log("");
  await knex.destroy();
  process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await knex.destroy();
  process.exit(2);
});
