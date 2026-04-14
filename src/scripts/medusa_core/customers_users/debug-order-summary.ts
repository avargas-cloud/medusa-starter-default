#!/usr/bin/env tsx
/**
 * debug-order-summary.ts
 * Diagnoses order_summary.totals for recent orders in Railway DB.
 * Usage: npx -y tsx src/scripts/debug/debug-order-summary.ts
 */
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected to Railway DB\n");

  // 1. Check order_summary for the 5 most recent orders
  const summaryResult = await client.query(`
        SELECT 
            o.display_id,
            o.id,
            o.status,
            os.totals,
            os.totals->>'current_order_total' AS current_order_total,
            os.totals->>'original_order_total' AS original_order_total,
            os.totals->>'accounting_total' AS accounting_total
        FROM "order" o
        LEFT JOIN order_summary os ON os.order_id = o.id
        ORDER BY o.created_at DESC
        LIMIT 10
    `);
  console.log("=== ORDER SUMMARY (last 10 orders) ===");
  for (const row of summaryResult.rows) {
    console.log(
      `#${row.display_id} (${row.status}) → current_order_total=${row.current_order_total} | original=${row.original_order_total} | accounting=${row.accounting_total}`
    );
    if (!row.current_order_total) {
      console.log(`  ⚠️  MISSING totals JSONB:`, JSON.stringify(row.totals));
    }
  }

  // 2. Check order_item for the most recent 3 orders
  const itemsResult = await client.query(`
        SELECT 
            o.display_id,
            oi.unit_price,
            oi.quantity,
            oi.raw_unit_price,
            oi.raw_quantity,
            oi.version,
            oli.title
        FROM "order" o
        JOIN order_line_item oli ON oli.order_id = o.id
        LEFT JOIN order_item oi ON oi.item_id = oli.id
        WHERE o.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY o.created_at DESC, oi.version DESC
        LIMIT 30
    `);
  console.log("\n=== ORDER ITEMS (last 24h) ===");
  for (const row of itemsResult.rows) {
    const uprice = row.unit_price ?? row.raw_unit_price?.value ?? "NULL";
    const qty = row.quantity ?? row.raw_quantity?.value ?? "NULL";
    console.log(
      `#${row.display_id} v${row.version} "${row.title}" → unit_price=${uprice}, qty=${qty}`
    );
  }

  // 3. Check if order_summary.totals has the correct structure
  const structureCheck = await client.query(`
        SELECT 
            o.display_id,
            jsonb_object_keys(os.totals) AS key
        FROM "order" o
        JOIN order_summary os ON os.order_id = o.id
        WHERE o.created_at > NOW() - INTERVAL '48 hours'
        ORDER BY o.display_id DESC, key
    `);
  console.log("\n=== TOTALS JSONB KEYS (last 48h) ===");
  const byOrder: Record<string, string[]> = {};
  for (const row of structureCheck.rows) {
    if (!byOrder[row.display_id]) byOrder[row.display_id] = [];
    byOrder[row.display_id].push(row.key);
  }
  for (const [dispId, keys] of Object.entries(byOrder)) {
    console.log(`#${dispId}: [${keys.join(", ")}]`);
  }

  await client.end();
  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
