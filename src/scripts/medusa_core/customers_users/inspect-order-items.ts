import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const orderId = "order_01KJTVX2EB54BASB3BJ4TXX8G7";

  // 1. Check order_summary totals
  const summary = await client.query(
    `
    SELECT id, totals, version FROM order_summary
    WHERE order_id = $1 AND deleted_at IS NULL
    ORDER BY version DESC LIMIT 1
  `,
    [orderId]
  );
  console.log("\n=== order_summary.totals ===");
  if (summary.rows[0])
    console.log(JSON.stringify(summary.rows[0].totals, null, 2));

  // 2. Check tax lines
  const taxLines = await client.query(
    `
    SELECT oltl.id, oltl.item_id, oltl.code, oltl.rate, oltl.amount, oltl.raw_amount, oltl.description
    FROM order_item oi
    JOIN order_line_item_tax_line oltl ON oltl.item_id = oi.item_id
    WHERE oi.order_id = $1 AND oi.deleted_at IS NULL AND oltl.deleted_at IS NULL
  `,
    [orderId]
  );
  console.log("\n=== order_line_item_tax_line ===");
  for (const r of taxLines.rows) console.log(JSON.stringify(r));

  // 3. Check native order total
  const orderRow = await client.query(
    `
    SELECT o.id, os.totals->>'current_order_total' as current_total,
           os.totals->>'raw_current_order_total' as raw_current_total
    FROM "order" o
    JOIN order_summary os ON os.order_id = o.id
    WHERE o.id = $1 AND o.deleted_at IS NULL AND os.deleted_at IS NULL
    ORDER BY os.version DESC LIMIT 1
  `,
    [orderId]
  );
  console.log("\n=== Order totals ===");
  for (const r of orderRow.rows) console.log(JSON.stringify(r));

  await client.end();
}
main().catch(console.error);
