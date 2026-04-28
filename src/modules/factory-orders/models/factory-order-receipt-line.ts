import { model } from "@medusajs/utils";

/**
 * One line per FO line received within a specific receipt.
 *
 * qty_received_now is the delta for this receipt; the denormalized
 * qty_received on the FO line is the running sum across receipts.
 *
 * stock_applied guarantees idempotency — set TRUE exactly once after
 * the stock delta is written to Medusa inventory_levels.
 */
export const FactoryOrderReceiptLine = model.define(
  "factory_order_receipt_line",
  {
    id: model.id({ prefix: "forl" }).primaryKey(),

    factory_order_receipt_id: model.text(),
    factory_order_line_id: model.text(),
    factory_order_id: model.text(),

    product_variant_id: model.text(),
    inventory_item_id: model.text(),
    sku_snapshot: model.text(),
    description_snapshot: model.text(),

    qty_received_now: model.number(),

    unit_cost_cents_override: model.number().nullable(),

    stock_applied: model.boolean().default(false),
    stock_applied_at: model.dateTime().nullable(),

    lot_number: model.text().nullable(),
    serial_numbers: model.json().nullable(),
  }
);
