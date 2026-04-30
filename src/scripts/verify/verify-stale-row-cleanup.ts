/**
 * Verifies B3 fix: stale-row cleanup helper correctly demotes rows past
 * their threshold. Uses an in-memory mock knex so we can run without DB.
 *
 * Run: tsx src/scripts/verify/verify-stale-row-cleanup.ts
 */
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
  INVENTORY_ADJUSTMENT_STALE_CONFIG,
} from "../../lib/quickbooks/stale-row-cleanup";

interface MockKnexCall {
  sql: string;
  bindings: unknown[];
}

function makeMockKnex(rowCounts: number[]) {
  const calls: MockKnexCall[] = [];
  let i = 0;
  const knex = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      calls.push({ sql, bindings });
      return { rowCount: rowCounts[i++] ?? 0 };
    },
  } as any;
  return { knex, calls };
}

function assert(cond: boolean, label: string) {
  if (!cond) {
    console.error(`❌ ${label}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}

async function testStandardConfig() {
  const { knex, calls } = makeMockKnex([3, 1]);
  const logs: string[] = [];
  const result = await markStaleRowsAsFailed(
    knex,
    "qb_purchase_order_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m) => logs.push(m) }
  );

  assert(calls.length === 2, "2 SQL UPDATEs (waiting + submitted)");
  assert(
    calls[0].sql.includes("WHERE status = ?"),
    "first UPDATE has WHERE status placeholder"
  );
  assert(
    calls[0].sql.includes("INTERVAL '20 minutes'"),
    "waiting threshold = 20 min"
  );
  assert(
    !calls[0].sql.includes("qb_operation_id = NULL"),
    "waiting cleanup does NOT clear qb_operation_id"
  );
  assert(
    calls[1].sql.includes("INTERVAL '30 minutes'"),
    "submitted threshold = 30 min"
  );
  assert(
    calls[1].sql.includes("qb_operation_id = NULL"),
    "submitted cleanup DOES clear qb_operation_id"
  );
  assert(result.marked === 4, `total marked = 4 (got ${result.marked})`);
  assert(result.byStatus.waiting === 3, "byStatus.waiting === 3");
  assert(result.byStatus.submitted === 1, "byStatus.submitted === 1");
  assert(logs.length === 2, "2 warn logs (one per status)");
}

async function testInventoryAdjustmentConfig() {
  const { knex, calls } = makeMockKnex([0, 2]);
  const result = await markStaleRowsAsFailed(
    knex,
    "qb_inventory_adjustment_pipeline",
    INVENTORY_ADJUSTMENT_STALE_CONFIG
  );

  assert(calls.length === 2, "IA: 2 SQL UPDATEs (waiting + processing)");
  assert(
    calls[1].bindings[1] === "processing",
    "IA: second status binding = 'processing' (not 'submitted')"
  );
  assert(result.marked === 2, "IA: total marked = 2");
  assert(result.byStatus.waiting === 0, "IA: byStatus.waiting === 0");
  assert(result.byStatus.processing === 2, "IA: byStatus.processing === 2");
}

async function testNoStaleRows() {
  const { knex, calls } = makeMockKnex([0, 0]);
  const logs: string[] = [];
  const result = await markStaleRowsAsFailed(
    knex,
    "qb_item_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m) => logs.push(m) }
  );

  assert(calls.length === 2, "still runs 2 UPDATEs");
  assert(result.marked === 0, "no rows marked");
  assert(logs.length === 0, "no warn logs when nothing stale");
}

async function main() {
  console.log("--- Standard config (PO/Receipt/Item) ---");
  await testStandardConfig();
  console.log("\n--- Inventory Adjustment config ---");
  await testInventoryAdjustmentConfig();
  console.log("\n--- No stale rows ---");
  await testNoStaleRows();
  console.log("\n🎉 B3 verification PASSED — Stale-row cleanup correct.");
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
