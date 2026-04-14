import "dotenv/config";
import { Client } from "pg";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT id, invoice_number, fulfillment_id FROM pos_invoice WHERE id = $1",
      ["01KMKY17VNTZMKBG24KDEWE5AK"]
    );
    console.log(res.rows);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
