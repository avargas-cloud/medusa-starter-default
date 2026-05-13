import { model } from "@medusajs/utils";

/**
 * One line per PO line received within a specific receipt.
 *
 * A single PO line may appear in multiple receipt_lines across different
 * receipts (partial shipments). qty_received_now is always the delta for
 * THIS receipt event — the denormalized qty_received on the PO line is
 * the sum.
 *
 * Cost override: vendor pricing occasionally differs from the PO commitment
 * (backorder substitutions, price changes). unit_cost_cents_override
 * captures the actual cost paid in this shipment; null means use the PO
 * line's unit_cost_cents unchanged.
 *
 * Stock safety: stock_applied is set TRUE exactly once, when the stock
 * delta is confirmed written to Medusa inventory_levels. Subscribers and
 * retry logic check this flag to guarantee idempotency — no receipt line
 * can apply stock twice.
 */
export const PurchaseOrderReceiptLine = model.define(
  "purchase_order_receipt_line",
  {
    id: model.id({ prefix: "porl" }).primaryKey(),

    purchase_order_receipt_id: model.text(),
    purchase_order_line_id: model.text(),
    purchase_order_id: model.text(), // denormalized for query convenience

    // Snapshots from the PO line at receipt time
    product_variant_id: model.text(),
    inventory_item_id: model.text(),
    sku_snapshot: model.text(),
    description_snapshot: model.text(),
    qb_item_list_id_snapshot: model.text().nullable(),

    // Receipt-specific quantities
    qty_received_now: model.number(),
    // Inventory on hand at the receive location BEFORE this receipt was applied.
    // Captured at receive time so the vendor bill confirm can compute AVCO
    // without reading current (post-sell) inventory. NULL for pre-fix receipts.
    qty_on_hand_at_receive: model.number().nullable(),

    // Optional cost override for this specific shipment
    unit_cost_cents_override: model.number().nullable(),

    // Idempotency flag — set true after successful stock write
    stock_applied: model.boolean().default(false),
    stock_applied_at: model.dateTime().nullable(),

    // Future-ready (unused in MVP): lot / serial tracking
    lot_number: model.text().nullable(),
    serial_numbers: model.json().nullable(),
  }
);
