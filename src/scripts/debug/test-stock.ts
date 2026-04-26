import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const sku = "EAP-AS1-8S";
    const res = await client.query(
      `
            SELECT i.id, i.sku, l.stocked_quantity, l.reserved_quantity 
            FROM inventory_item i
            JOIN inventory_level l ON l.inventory_item_id = i.id
            WHERE i.sku = $1;
        `,
      [sku]
    );

    console.log("DB Inventory Levels for " + sku + ":");
    console.table(res.rows);

    const resv = await client.query(
      `SELECT COUNT(*) as count FROM reservation_item`
    );
    console.log("Total Reservation Items in DB:", resv.rows[0].count);
  } catch (e) {
    console.error("Error:", (e as Error).message);
  } finally {
    await client.end();
  }
}
main();
