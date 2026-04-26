import * as dotenv from "dotenv";
import { Pool } from "pg";
dotenv.config();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/medusa",
});

async function check() {
  try {
    const orderId = "order_01KMKWWRJX09VS52MM0NJX85ZW";
    const oRes = await pool.query(
      'SELECT id, display_id, status FROM "order" WHERE id = $1',
      [orderId]
    );
    const order = oRes.rows[0];
    if (!order) {
      console.log("Order not found");
      process.exit(0);
    }

    console.log("--- ORDER ---");
    console.log(order);

    const iRes = await pool.query(
      `
      SELECT oi.id as order_item_id, oi.item_id as line_item_id, oi.quantity, oi.fulfilled_quantity, oli.title, oli.variant_sku 
      FROM order_item oi 
      JOIN order_line_item oli ON oi.item_id = oli.id 
      WHERE oi.order_id = $1`,
      [order.id]
    );
    console.log("--- ITEMS ---");
    console.table(iRes.rows);

    const fRes = await pool.query(
      "SELECT f.id as fulfillment_id, f.provider_id FROM fulfillment f JOIN order_fulfillment of ON f.id = of.fulfillment_id WHERE of.order_id = $1",
      [order.id]
    );
    console.log("--- FULFILLMENTS ---");
    console.table(fRes.rows.length ? fRes.rows : [{ fulfillment_id: "None" }]);

    const invRes = await pool.query(
      "SELECT id, invoice_number, status, total, fulfillment_id FROM pos_invoice WHERE order_id = $1",
      [order.id]
    );
    console.log("--- INVOICES ---");
    console.table(invRes.rows.length ? invRes.rows : [{ id: "None" }]);

    const resvRes = await pool.query(
      `
      SELECT ri.id as reservation_id, ri.quantity, ri.line_item_id 
      FROM reservation_item ri 
      JOIN order_line_item oli ON ri.line_item_id = oli.id 
      JOIN order_item oi ON oli.id = oi.item_id 
      WHERE oi.order_id = $1 AND ri.deleted_at IS NULL`,
      [order.id]
    );
    console.log("--- RESERVATIONS (ALLOCATED) ---");
    console.table(
      resvRes.rows.length ? resvRes.rows : [{ reservation_id: "None" }]
    );
  } finally {
    await pool.end();
  }
}
check();
