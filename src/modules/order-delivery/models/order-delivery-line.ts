import { model } from "@medusajs/utils";

/**
 * Units covered by one delivery when its assignment is item-scoped
 * (order_delivery.invoice_scope = 'items') — the PO tracking pattern
 * (purchase_order_tracking_line) applied to outbound invoices.
 *
 * Rows exist ONLY for item-scoped assignments; an 'entire_invoice' assignment
 * covers every invoice line implicitly and writes none. Quantities are frozen
 * at assignment time; the invoice line (via order_line_item_id) is the
 * identity that survives same-SKU duplicates.
 */
export const OrderDeliveryLine = model.define("order_delivery_line", {
  id: model.id({ prefix: "odll" }).primaryKey(),

  delivery_id: model.text(), // FK (external) → order_delivery.id
  order_line_item_id: model.text(), // FK (external) → order_line_item.id
  quantity: model.number(),
});
