import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import {
  buildQbItems,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
} from "../src/lib/quickbooks/order-flow-core";

export default async function myScript({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // Fetch order 1171
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "status",
      "metadata",
      "tax_total",
      "total",
      "subtotal",
      "discount_total",
      "items.*",
      "items.variant.*",
      "items.variant.metadata",
      "shipping_methods.*",
    ],
    filters: { display_id: 1171 },
  });

  if (!order) {
    console.log("Order not found");
    return;
  }

  console.log("== RAW ORDER ==");
  console.log("Subtotal (cents):", order.subtotal);
  console.log("Discount Total (cents):", order.discount_total);
  console.log("Tax Total (cents):", order.tax_total);
  console.log("Total (cents):", order.total);

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
}
