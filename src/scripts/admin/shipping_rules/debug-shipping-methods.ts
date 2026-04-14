import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const orderId = "order_01KK36AQ98XGBT0X3B8HXS6Q8F";

  // Check order_shipping join table columns
  const joinCols = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'order_shipping'
        ORDER BY ordinal_position
    `);
  console.log("\n=== order_shipping columns ===");
  console.log(joinCols.rows.map((r: any) => r.column_name).join(", "));

  // Query order_shipping for this order
  const join = await client.query(
    `
        SELECT os.*, osm.name, osm.amount
        FROM order_shipping os
        JOIN order_shipping_method osm ON os.shipping_method_id = osm.id
        WHERE os.order_id = $1
          AND osm.deleted_at IS NULL
    `,
    [orderId]
  );
  console.log("\n=== order_shipping rows ===");
  console.log(JSON.stringify(join.rows, null, 2));

  // Also check the order's cart to see cart_shipping_methods
  const cartId = await client.query(
    `
        SELECT cart_id FROM "order" WHERE id = $1
    `,
    [orderId]
  );
  console.log("\n=== order.cart_id ===", JSON.stringify(cartId.rows));

  if (cartId.rows[0]?.cart_id) {
    const cartShipping = await client.query(
      `
            SELECT id, name, amount, shipping_option_id
            FROM cart_shipping_method
            WHERE cart_id = $1 AND deleted_at IS NULL
        `,
      [cartId.rows[0].cart_id]
    );
    console.log("\n=== cart_shipping_method ===");
    console.log(JSON.stringify(cartShipping.rows, null, 2));
  }

  const r2 = await client.query(
    `
        SELECT id, status, created_at
        FROM order_change
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 5
    `,
    [orderId]
  );
  console.log("\n=== order_change (last 5) ===");
  console.log(JSON.stringify(r2.rows, null, 2));

  const r3 = await client.query(
    `
        SELECT id, version, is_draft_order FROM "order" WHERE id = $1
    `,
    [orderId]
  );
  console.log("\n=== order ===");
  console.log(JSON.stringify(r3.rows, null, 2));

  await client.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
