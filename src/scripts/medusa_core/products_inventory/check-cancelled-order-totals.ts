/**
 * check-cancelled-order-totals.ts
 *
 * Inspects the raw JSONB structure of order_summary.totals for cancelled orders.
 * Helps debug why Admin panel shows $0 — shows actual DB values including nested BigNumber structure.
 *
 * Usage:
 *   cd backend && npx dotenv-cli -e .env -- npx tsx src/scripts/checks/check-cancelled-order-totals.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("🔍 Inspecting cancelled order_summary.totals structure\n");

  const rows = await client.query(`
        SELECT
          o.display_id,
          o.status,
          os.totals,
          os.updated_at
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id
        WHERE o.status = 'canceled'
        ORDER BY o.display_id DESC
        LIMIT 10
    `);

  if (rows.rows.length === 0) {
    console.log("No cancelled orders found.");
    await client.end();
    return;
  }

  for (const row of rows.rows) {
    const totals = row.totals;
    console.log(`\n━━━ Order #${row.display_id} (${row.status}) ━━━`);
    console.log("raw totals:", JSON.stringify(totals, null, 2));

    // Try to read current_order_total in various formats
    const flat = totals?.current_order_total;
    const nested = totals?.current_order_total?.value;
    console.log(`  current_order_total (flat):   ${flat}`);
    console.log(`  current_order_total (nested):  ${nested}`);
    console.log(
      `  transaction_total:             ${totals?.transaction_total?.value ?? totals?.transaction_total}`
    );
    console.log(
      `  accounting_total:              ${totals?.accounting_total?.value ?? totals?.accounting_total}`
    );
  }

  await client.end();
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
