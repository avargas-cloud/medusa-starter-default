import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Fetch order 1182
  const { rows } = await client.query(
    `SELECT id, display_id, is_draft_order, metadata FROM "order" WHERE display_id = 1182;`
  );

  if (rows.length === 0) console.log("Order 1182 not found!");
  else {
    const order = rows[0];
    console.log(`Order ID: ${order.id}`);
    console.log(`Is Draft (Estimate): ${order.is_draft_order}`);
    console.log(`Metadata:`, JSON.stringify(order.metadata, null, 2));
  }

  await client.end();
}

main().catch(console.error);
