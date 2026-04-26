import { model } from "@medusajs/utils";

/**
 * One line per product variant on a purchase order.
 *
 * Snapshot rule: sku, description, unit_cost, qb_item_list_id are frozen at
 * submit time. Future product edits never mutate an existing PO line.
 *
 * Counters: qty_received is a denormalized SUM over all non-voided receipt
 * lines pointing to this PO line. Refreshed whenever a receipt is
 * created/voided.
 *
 * status:
 *   open       → qty_received = 0
 *   partial    → 0 < qty_received < qty_ordered
 *   complete   → qty_received >= qty_ordered
 *   cancelled  → admin removed the remaining open qty
 */
export const PurchaseOrderLine = model.define("purchase_order_line", {
  id: model.id({ prefix: "pol" }).primaryKey(),

  purchase_order_id: model.text(),

  // Product references
  product_variant_id: model.text(),
  inventory_item_id: model.text(),

  // Snapshots — survive variant edits
  sku_snapshot: model.text(),
  description_snapshot: model.text(),
  qb_item_list_id_snapshot: model.text().nullable(),

  // Quantities
  qty_ordered: model.number(),
  qty_received: model.number().default(0), // denormalized sum over receipts
  qty_cancelled: model.number().default(0), // portion explicitly cancelled by admin

  // Pricing in cents (USD)
  unit_cost_cents: model.number(),
  tax_cents: model.number().default(0),
  total_cents: model.number(),

  status: model.text().default("open"),

  // Presentation order on the PO
  line_order: model.number().default(0),

  // Free-text
  notes: model.text().nullable(),

  // QB sync — TxnLineID assigned by QuickBooks after PurchaseOrderAdd completes
  qb_txn_line_id: model.text().nullable(),
});
