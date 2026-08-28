import {
  buildQbItems,
  buildQbOrderDiscountLines,
  buildShippingQbItem,
  type MedusaOrderForQb,
} from "./order-flow-core";
import { getFloat } from "./handlers/utils";
import type { QbOrderItem } from "./client/types";

/**
 * Builds the line set for a QB SalesOrderMod.
 *
 * WHY THIS EXISTS — a MOD is a full snapshot, so a line the payload omits gets
 * DELETED from the Sales Order. handle-order-updated built its items from
 * `order.items` alone and never added the shipping line, so every edit of an
 * order with freight silently stripped that line out of the QB Sales Order,
 * even though the CREATE path (handle-order-placed) had put it there.
 *
 * Cost: order 3231 (S11614, Uber $25). An edit at 14:59 deleted the freight
 * line from SO 6492 — QB dropped from $63.46 to $38.46 while the POS still
 * said $63.46 — and the invoice that followed died with QB Error 3210 pointing
 * at the TxnLineID that edit had just removed.
 *
 * The order-level Subtotal / Discount pair (`buildQbOrderDiscountLines`) is
 * included too, as of 2026-08-28. Stripping it was the same bug as the freight
 * one and it had already hit four Sales Orders in production (S11557 -$198.61,
 * S2937 -$295.65, S11543 -$22.46, S11417 -$10.38): QB showed the order at full
 * price while the POS showed it discounted.
 *
 * The pair is emitted WITHOUT a productId because it is addressed by name — but
 * it is NOT identity-less: QuickBooks does give those two items a ListID
 * (Subtotal 80000D54-…, Discount 8000040C-…), so they already appear in the
 * live line map keyed by ListID. `syntheticOrderLine` marks them so
 * updateSalesOrderInQb can resolve that ListID off the fetched Sales Order and
 * reuse the existing TxnLineID, instead of appending a duplicate pair on every
 * edit. The marker is stripped before the payload reaches the bridge.
 *
 * ORDER IS LOAD-BEARING: a QB Subtotal item totals the lines ABOVE it, so the
 * pair goes after the products and before shipping — exactly where the CREATE
 * path puts it (handle-order-placed). Shipping after the discount is correct
 * and intentional: the POS never discounts freight.
 *
 * Shipping is safe on its own because it carries a real productId (the QB
 * item's ListID), so the mod matches it to its TxnLineID and QB updates it in
 * place.
 */
export function buildSalesOrderModQbItems(input: {
  items: MedusaOrderForQb["items"];
  metadata?: Record<string, any>;
  /** order.shipping_methods as returned by query.graph (amounts may be strings/BigNumber). */
  shippingMethods?: any[];
  /** qbConfig.shippingItemId — never hardcode the ListID at the callsite. */
  shippingItemId?: string;
  // Derived from buildQbItems rather than re-declared: ProductQbInfo is local
  // to order-flow-core, and widening its visibility just to name it here would
  // put a type-only edit into a file this change has no business touching.
  productTaxableMap?: Parameters<typeof buildQbItems>[2];
  lineTaxableMap?: Parameters<typeof buildQbItems>[3];
  /** getEffectiveOrderDiscount(order) — dollars, 0 when there is no discount. */
  orderDiscountTotal?: number;
  /** order.subtotal — only used to render the "(N%)" suffix on the desc. */
  orderSubtotal?: number;
}): QbOrderItem[] {
  const items = buildQbItems(
    input.items,
    input.metadata,
    input.productTaxableMap,
    input.lineTaxableMap
  );

  const discountTotal = Number(input.orderDiscountTotal || 0);
  const subtotal = Number(input.orderSubtotal || 0);
  const discountLines =
    discountTotal > 0
      ? buildQbOrderDiscountLines(
          discountTotal,
          subtotal > 0 ? (discountTotal / subtotal) * 100 : null
        ).map((line) => ({ ...line, syntheticOrderLine: true as const }))
      : [];

  // Money fields from query.graph arrive as string | BigNumber | number —
  // buildShippingQbItem does `Number(method.amount || 0)`, which yields NaN for
  // the BigNumber shape and would drop the line as "free shipping".
  const shippingMethods = (input.shippingMethods || []).map((sm: any) => ({
    ...sm,
    amount: getFloat(sm?.amount),
  }));

  const shippingItem = buildShippingQbItem(
    shippingMethods,
    input.shippingItemId
  );

  return [...items, ...discountLines, ...(shippingItem ? [shippingItem] : [])];
}
