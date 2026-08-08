/**
 * src/modules/invoices/models/pos-invoice-item.ts
 * Snapshot of the line items dispatched in a single invoice.
 * Stored at issue time so changes to the Order don't mutate existing invoices.
 */

import { model } from "@medusajs/utils";

import PosInvoice from "./pos-invoice";

const PosInvoiceItem = model.define("pos_invoice_item", {
  id: model.id().primaryKey(),
  invoice: model.belongsTo(() => PosInvoice, { mappedBy: "items" }),
  variant_id: model.text().nullable(),
  // FK (external, no constraint) → order_line_item.id (`ordli_`). The line
  // identity that makes two same-SKU order lines distinguishable — required
  // for derived shipment↔invoice linkage (delivery v2). NULL on legacy
  // invoices and on custom/comment lines that never existed on the order.
  order_line_item_id: model.text().nullable(),
  sku: model.text().nullable(),
  description: model.text(),
  quantity: model.number(),
  refunded_quantity: model.number().default(0), // cumulative units refunded via credit memos
  unit_price: model.bigNumber(),
  total: model.bigNumber(),
  attached_image: model.text().nullable(),
  // Snapshot of the canonical variant.metadata.average_cost (via the cost
  // resolver) at the moment the invoice was issued. Frozen forever — later
  // cost changes never back-propagate here. NULL for custom lines without a
  // variant_id and for variants that had no cost yet.
  average_unit_cost: model.bigNumber().nullable(),
  // Snapshot of the cost's freshness timestamp (average_cost_updated_at) at issue time.
  // Lets reports show cost freshness ("based on a sync from N days ago").
  average_unit_cost_synced_at: model.dateTime().nullable(),
  // Snapshotted at invoice creation by DB trigger (trg_pos_invoice_item_taxable_default)
  // which resolves product.taxable via variant→product JOIN. True = taxable (default).
  taxable: model.boolean().default(true),
  // Per-item discount snapshotted at invoice creation — self-contained, never
  // derived from the live order. NULL = no discount on this line.
  discount_type: model.text().nullable(),   // 'percent' | 'fixed'
  discount_value: model.number().nullable(), // percentage (0-100) or fixed dollar amount
  // Frozen post-line-discount, PRE-order-discount net line total in cents,
  // computed by the POS with the round-then-multiply convention (2026-05-29).
  // The QB sync READS this verbatim instead of recomputing the discount, so the
  // QB line equals what Medusa charged (net/qty yields the clean rounded rate →
  // rate × qty === amount, calculator-clean). NULL = legacy invoice issued before
  // this column existed: the sync falls back to the old recompute and the doc
  // reproduces its original amount untouched. Forward-only by data presence.
  net_total_cents: model.bigNumber().nullable(),
});

export default PosInvoiceItem;
