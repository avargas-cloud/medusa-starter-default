import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n🔍 Analyzing Database for Orphaned Records...\n`);

  const tablesToCheck = [
    // Finance / Ledger
    "customer_payment",
    "payment_application",
    "invoice_payment",
    "pos_invoice",
    "pos_invoice_item",
    "invoice_tracking",
    // Payments
    "payment_collection",
    "payment_session",
    "payment",
    "order_payment_collection",
    // Order / Cart
    '"order"',
    "order_item",
    "order_shipping",
    "order_summary",
    "order_transaction",
    "order_change",
    "order_address",
    // Fulfillments
    "fulfillment",
    "order_fulfillment",
    "return",
    "order_return",
  ];

  for (const table of tablesToCheck) {
    try {
      const res = await client.query(`SELECT COUNT(*) FROM ${table}`);
      console.log(`Table ${table.padEnd(25)}: ${res.rows[0].count} records`);
    } catch (e) {
      console.log(`Table ${table.padEnd(25)}: ERROR or DOES NOT EXIST`);
    }
  }

  // Check for fulfillments linked to non-existent orders
  console.log("\nChecking for specific orphans...");
  try {
    const orphanFulfillments = await client.query(`
            SELECT COUNT(*) FROM order_fulfillment of
            LEFT JOIN "order" o ON of.order_id = o.id
            WHERE o.id IS NULL
        `);
    console.log(
      `Orphaned order_fulfillments   : ${orphanFulfillments.rows[0].count}`
    );
  } catch (e) {}

  await client.end();
}

main().catch(console.error);
