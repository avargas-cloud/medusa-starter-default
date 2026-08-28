import {
  buildQbItems,
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
 * DELIBERATELY NOT INCLUDED — the order-level Subtotal / Discount pair
 * (`buildQbOrderDiscountLines`). Those lines are addressed by
 * `ItemRef.FullName` and carry NO productId, so updateSalesOrderInQb cannot
 * match them against an existing TxnLineID: every MOD would append a fresh
 * pair and the Sales Order would grow a duplicate discount each time an order
 * is edited. A MOD that strips them (today's behavior) is wrong but bounded; a
 * MOD that duplicates them corrupts the document. Fixing that needs the same
 * treatment credit memos got — persisting synthetic line ids by FullName
 * (`credit-memo-synthetic-lines.ts`) — and is tracked separately.
 *
 * Shipping is safe precisely because it does carry a productId (the QB item's
 * ListID), so the mod matches it to its existing TxnLineID and QuickBooks
 * updates the line in place.
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
}): QbOrderItem[] {
  const items = buildQbItems(
    input.items,
    input.metadata,
    input.productTaxableMap,
    input.lineTaxableMap
  );

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

  return shippingItem ? [...items, shippingItem] : items;
}
