import { getDbPool } from "../../api/utils/db-pool";

export default async function dumpRes() {
  const pool = getDbPool();
  const id = "order_01KMGWYGD4FEHXPJWAVWATDHC2";

  // Dump all reservation items linked to any variant of this order's items
  console.log("Fetching order_item IDs...");
  const oiRes = await pool.query(
    `SELECT id, item_id, quantity FROM order_item WHERE order_id = $1`,
    [id]
  );
  console.log("Order Items in DB:", oiRes.rows);

  console.log("\nFetching reservation items for these line_item_ids:");
  const rRes = await pool.query(
    `
      SELECT id, line_item_id, inventory_item_id, quantity, created_at, updated_at 
      FROM reservation_item 
      WHERE line_item_id = ANY($1) OR line_item_id = ANY($2)
  `,
    [oiRes.rows.map((r) => r.id), oiRes.rows.map((r) => r.item_id)]
  );

  console.log("Reservations found:");
  console.log(JSON.stringify(rRes.rows, null, 2));
}
