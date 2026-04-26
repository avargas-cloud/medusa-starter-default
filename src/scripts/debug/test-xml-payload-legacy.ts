import "dotenv/config";
import { ContainerRegistrationKeys } from "@medusajs/utils";
// Ensure we use pg to run a raw query
import { Client } from "pg";
import {
  buildQbItems,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
} from "./src/lib/quickbooks/order-flow-core";

async function run() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Fetch order 1171
  const { rows: orderRows } = await c.query(
    'SELECT * FROM "order" WHERE display_id = 1171'
  );
  const order = orderRows[0];

  // Fetch items
  const { rows: items } = await c.query(
    "SELECT * FROM order_item WHERE order_id = $1",
    [order.id]
  );

  // Fetch variants metadata
  for (const item of items) {
    const { rows: variants } = await c.query(
      "SELECT metadata, sku FROM product_variant WHERE id = $1",
      [item.variant_id]
    );
    item.variant = variants[0] || {};
  }
  order.items = items;

  // Fetch shipping
  const { rows: shipping } = await c.query(
    "SELECT * FROM order_shipping_method WHERE order_id = $1",
    [order.id]
  );
  order.shipping_methods = shipping;

  console.log("== RAW ORDER ==");
  console.log("Subtotal (cents):", order.subtotal);
  console.log("Discount Total (cents):", order.discount_total);
  console.log("Tax Total (cents):", order.tax_total);
  console.log("Total (cents):", order.total);

  // Build QB Items
  const activeItems = (order.items || []).map((item: any) => ({
    ...item,
    unit_price: Math.round((item.unit_price || 0) * 100),
    subtotal: undefined, // Force buildQbItems to use original unit_price
  }));

  const prebuiltItems = buildQbItems(activeItems, order.metadata);

  const orderDiscountTotal = Math.round((order.discount_total || 0) * 100);
  if (orderDiscountTotal > 0) {
    const orderSubtotal = Math.round((order.subtotal || 0) * 100);
    const discountPercent =
      orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null;
    buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(
      (l: any) => prebuiltItems.push(l)
    );
  }

  const shippingItem = buildShippingQbItem(
    (order as any).shipping_methods || [],
    "SHIPPING_ITEM_ID"
  );
  if (shippingItem) {
    prebuiltItems.push(shippingItem as any);
  }

  console.log("\n== GENERATED QB ITEMS PAYLOAD ==");
  console.log(JSON.stringify(prebuiltItems, null, 2));

  c.end();
}
run().catch(console.error);
