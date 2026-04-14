/**
 * purge-cancelled-orders.ts
 *
 * Permanently deletes ALL cancelled (non-draft) orders and every related record.
 *
 * CASCADE tables (auto-deleted when order row is deleted):
 *   order_change, order_credit_line, order_item, order_shipping,
 *   order_summary, order_transaction
 *
 * Manual tables (handled explicitly before/after):
 *   1. payment_session  → references payment_collection
 *   2. payment          → references payment_collection
 *   3. payment_collection → references order (order_id)
 *   4. order_address    → referenced BY order (FK on shipping/billing address columns)
 *
 * Redis: fully flushed after deletion to clear all Medusa caches.
 *
 * Usage:
 *   DRY_RUN=true  npx tsx src/scripts/nuclear/purge-cancelled-orders.ts
 *   DRY_RUN=false npx tsx src/scripts/nuclear/purge-cancelled-orders.ts
 *
 * ⚠️  IRREVERSIBLE. Always run DRY_RUN=true first and review the output.
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";
const REDIS_URL = process.env.REDIS_URL;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function hr() {
  console.log("─".repeat(60));
}

async function count(
  client: Client,
  table: string,
  where: string,
  params: any[] = []
) {
  const res = await client.query(
    `SELECT COUNT(*) FROM ${table} WHERE ${where}`,
    params
  );
  return parseInt(res.rows[0].count, 10);
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n🧹 Purge Cancelled Orders  [DRY_RUN=${DRY_RUN}]\n`);
  hr();

  // ── 1. Identify target orders ──────────────────────────────────────────
  const ordersResult = await client.query(`
        SELECT id, display_id, status, canceled_at
        FROM "order"
        WHERE status = 'canceled'
          AND is_draft_order = false
          AND deleted_at IS NULL
        ORDER BY display_id DESC
    `);

  const orders = ordersResult.rows;
  const orderIds = orders.map((o) => o.id);

  if (orders.length === 0) {
    console.log("✅ No cancelled orders found. Nothing to purge.");
    await client.end();
    return;
  }

  console.log(`Found ${orders.length} cancelled order(s):\n`);
  for (const o of orders) {
    console.log(
      `  #${o.display_id.toString().padStart(4, " ")}  id=${o.id}  canceled_at=${o.canceled_at?.toISOString().slice(0, 10) ?? "?"}`
    );
  }
  hr();

  // ── 2. Count related records ──────────────────────────────────────────
  // payment_collection is linked via pivot table order_payment_collection
  const PAY_COL_IDS_SQL = `
        SELECT opc.payment_collection_id
        FROM order_payment_collection opc
        WHERE opc.order_id = ANY($1::text[])
    `;

  const [
    cPayCols,
    cPaySessions,
    cPayments,
    cAddresses,
    // cascade counts (informational)
    cOrderItems,
    cOrderSummaries,
    cOrderChanges,
    cOrderTransactions,
    cOrderShipping,
    cOrderCreditLines,
  ] = await Promise.all([
    count(client, "payment_collection", `id IN (${PAY_COL_IDS_SQL})`, [
      orderIds,
    ]),
    count(
      client,
      "payment_session",
      `payment_collection_id IN (${PAY_COL_IDS_SQL})`,
      [orderIds]
    ),
    count(client, "payment", `payment_collection_id IN (${PAY_COL_IDS_SQL})`, [
      orderIds,
    ]),
    count(
      client,
      "order_address",
      `id IN (
                SELECT shipping_address_id FROM "order" WHERE id = ANY($1::text[]) AND shipping_address_id IS NOT NULL
                UNION
                SELECT billing_address_id FROM "order" WHERE id = ANY($1::text[]) AND billing_address_id IS NOT NULL
            )`,
      [orderIds]
    ),
    count(client, "order_item", "order_id = ANY($1::text[])", [orderIds]),
    count(client, "order_summary", "order_id = ANY($1::text[])", [orderIds]),
    count(client, "order_change", "order_id = ANY($1::text[])", [orderIds]),
    count(client, "order_transaction", "order_id = ANY($1::text[])", [
      orderIds,
    ]),
    count(client, "order_shipping", "order_id = ANY($1::text[])", [orderIds]),
    count(client, "order_credit_line", "order_id = ANY($1::text[])", [
      orderIds,
    ]),
  ]);

  console.log(`Records to be deleted:\n`);
  console.log(`  MANUAL DELETIONS (before order):`);
  console.log(`    payment_session     : ${cPaySessions}`);
  console.log(`    payment             : ${cPayments}`);
  console.log(`    payment_collection  : ${cPayCols}`);
  console.log(`  CASCADE on order DELETE:`);
  console.log(`    order_change        : ${cOrderChanges}`);
  console.log(`    order_credit_line   : ${cOrderCreditLines}`);
  console.log(`    order_item          : ${cOrderItems}`);
  console.log(`    order_shipping      : ${cOrderShipping}`);
  console.log(`    order_summary       : ${cOrderSummaries}`);
  console.log(`    order_transaction   : ${cOrderTransactions}`);
  console.log(`  CLEANUP AFTER order:`);
  console.log(`    order_address       : ${cAddresses}`);
  console.log(`    order (main)        : ${orders.length}`);
  hr();

  if (DRY_RUN) {
    console.log("⚠️  DRY RUN — no changes made.");
    console.log("   Review the above and run with DRY_RUN=false to apply.\n");
    await client.end();
    return;
  }

  // ── 3. Execute deletions inside a transaction ─────────────────────────
  await client.query("BEGIN");

  try {
    // Step A: collect payment_collection IDs via pivot
    const payColResult = await client.query(
      `
            SELECT DISTINCT payment_collection_id
            FROM order_payment_collection
            WHERE order_id = ANY($1::text[])
        `,
      [orderIds]
    );
    const payColIds: string[] = payColResult.rows.map(
      (r) => r.payment_collection_id
    );

    // Step B: delete payment children (CASCADE from payment_collection handles session+payment,
    //         but we do explicit deletes to be safe and get accurate rowCounts)
    let rPaySessions = 0,
      rPayments = 0,
      rPayCols = 0;
    if (payColIds.length > 0) {
      const rs = await client.query(
        `DELETE FROM payment_session WHERE payment_collection_id = ANY($1::text[])`,
        [payColIds]
      );
      rPaySessions = rs.rowCount ?? 0;

      const rp = await client.query(
        `DELETE FROM payment WHERE payment_collection_id = ANY($1::text[])`,
        [payColIds]
      );
      rPayments = rp.rowCount ?? 0;

      // Delete pivot table entries first
      await client.query(
        `DELETE FROM order_payment_collection WHERE order_id = ANY($1::text[])`,
        [orderIds]
      );

      const rpc = await client.query(
        `DELETE FROM payment_collection WHERE id = ANY($1::text[])`,
        [payColIds]
      );
      rPayCols = rpc.rowCount ?? 0;
    }

    // Step C: collect address IDs before deleting order
    const addressResult = await client.query(
      `
            SELECT DISTINCT unnest(ARRAY[shipping_address_id, billing_address_id]) AS addr_id
            FROM "order"
            WHERE id = ANY($1::text[])
              AND (shipping_address_id IS NOT NULL OR billing_address_id IS NOT NULL)
        `,
      [orderIds]
    );
    const addressIds = addressResult.rows.map((r) => r.addr_id).filter(Boolean);

    // Step D: delete orders (triggers CASCADE on 6 tables)
    const { rowCount: rOrders } = await client.query(
      `
            DELETE FROM "order" WHERE id = ANY($1::text[])
        `,
      [orderIds]
    );

    // Step E: delete orphaned addresses
    let rAddresses = 0;
    if (addressIds.length > 0) {
      const res = await client.query(
        `
                DELETE FROM order_address WHERE id = ANY($1::text[])
            `,
        [addressIds]
      );
      rAddresses = res.rowCount ?? 0;
    }

    await client.query("COMMIT");

    console.log(`\n✅ Deletion complete:\n`);
    console.log(`  payment_session    : ${rPaySessions ?? 0} deleted`);
    console.log(`  payment            : ${rPayments ?? 0} deleted`);
    console.log(`  payment_collection : ${rPayCols ?? 0} deleted`);
    console.log(`  order (+ CASCADE)  : ${rOrders ?? 0} deleted`);
    console.log(`  order_address      : ${rAddresses} deleted`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      "\n❌ Error during deletion — ROLLED BACK:",
      (err as Error).message
    );
    await client.end();
    process.exit(1);
  }

  await client.end();
  hr();

  // ── 4. Flush Redis ────────────────────────────────────────────────────
  if (REDIS_URL) {
    console.log("\n🔴 Flushing Redis cache...");
    try {
      const { default: Redis } = (await import("ioredis")) as any;
      const redis = new Redis(REDIS_URL, {
        connectTimeout: 8000,
        commandTimeout: 8000,
        lazyConnect: true,
      });
      await redis.connect();
      await redis.flushall();
      await redis.quit();
      console.log("✅ Redis flushed (FLUSHALL)");
    } catch (e) {
      console.warn("⚠️  Redis flush failed:", (e as Error).message);
    }
  } else {
    console.warn("⚠️  REDIS_URL not set — skipping Redis flush");
  }

  console.log(
    `\n🎉 Done! ${orders.length} cancelled order(s) permanently purged.\n`
  );
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
