#!/usr/bin/env tsx
/**
 * debug-raw-prices.ts
 * Verifies raw_unit_price and raw_quantity in cart vs order line items
 * for recent orders to understand why completeCartWorkflow gives wrong totals.
 */
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected\n");

  // 1. order_summary: how many rows per order?
  const dupCheck = await client.query(`
        SELECT order_id, COUNT(*) as cnt, 
               array_agg(current_order_total::text ORDER BY updated_at DESC) as totals_history
        FROM (
            SELECT order_id, 
                   (totals->>'current_order_total')::numeric as current_order_total,
                   updated_at
            FROM order_summary
        ) sub
        GROUP BY order_id
        HAVING COUNT(*) > 0
        ORDER BY MAX(updated_at) DESC
        LIMIT 8
    `);
  console.log("=== order_summary rows per order (newest first) ===");
  for (const r of dupCheck.rows) {
    const flag = r.cnt > 1 ? "⚠️  DUPLICATE" : "✅";
    console.log(
      `${flag} order_id=${r.order_id} rows=${r.cnt} totals_history=${r.totals_history}`
    );
  }

  // 2. order_line_item: raw_unit_price and raw_quantity for #1048
  const lineItems = await client.query(`
        SELECT 
            o.display_id,
            oli.title,
            oli.unit_price,
            oli.raw_unit_price,
            oli.quantity,
            oli.raw_quantity,
            oli.created_at
        FROM order_line_item oli
        JOIN "order" o ON o.id = oli.order_id
        WHERE o.display_id IN (1048, 1047)
        ORDER BY o.display_id DESC, oli.created_at ASC
    `);
  console.log("\n=== order_line_item raw fields (1047, 1048) ===");
  for (const r of lineItems.rows) {
    console.log(`#${r.display_id} "${r.title}"`);
    console.log(`  unit_price       = ${r.unit_price}`);
    console.log(`  raw_unit_price   = ${JSON.stringify(r.raw_unit_price)}`);
    console.log(`  quantity         = ${r.quantity}`);
    console.log(`  raw_quantity     = ${JSON.stringify(r.raw_quantity)}`);
  }

  // 3. order_item versions: the event-sourced table
  const orderItems = await client.query(`
        SELECT 
            o.display_id,
            oi.version,
            oi.unit_price,
            oi.raw_unit_price,
            oi.quantity,
            oi.raw_quantity,
            oi.item_id,
            oi.created_at
        FROM order_item oi
        JOIN order_line_item oli ON oli.id = oi.item_id
        JOIN "order" o ON o.id = oli.order_id
        WHERE o.display_id IN (1048)
        ORDER BY oi.version ASC
    `);
  console.log("\n=== order_item VERSIONS for #1048 (event sourced) ===");
  for (const r of orderItems.rows) {
    console.log(
      `  v${r.version}: unit_price=${r.unit_price} raw_up=${JSON.stringify(r.raw_unit_price)} qty=${r.quantity} raw_qty=${JSON.stringify(r.raw_quantity)}`
    );
  }

  // 4. order_summary rows for order #1048 (all of them)
  const summaryRows = await client.query(`
        SELECT os.id, os.totals, os.created_at, os.updated_at
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id
        WHERE o.display_id = 1048
        ORDER BY os.updated_at ASC
    `);
  console.log("\n=== order_summary ALL rows for #1048 ===");
  for (const r of summaryRows.rows) {
    console.log(`  id=${r.id}`);
    console.log(
      `  current=${r.totals?.current_order_total} original=${r.totals?.original_order_total} accounting=${r.totals?.accounting_total}`
    );
    console.log(`  created=${r.created_at} updated=${r.updated_at}`);
  }

  await client.end();
  console.log("\n✅ Done.");
}
main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
