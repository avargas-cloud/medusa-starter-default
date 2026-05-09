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
  sku: model.text().nullable(),
  description: model.text(),
  quantity: model.number(),
  refunded_quantity: model.number().default(0), // cumulative units refunded via credit memos
  unit_price: model.bigNumber(),
  total: model.bigNumber(),
  attached_image: model.text().nullable(),
  // Snapshot of variant.metadata.qb_avg_cost at the moment the invoice was
  // issued. Frozen forever — QB sync never back-propagates here. NULL for
  // custom lines without a variant_id and for variants whose qb_avg_cost
  // had not been synced yet.
  average_unit_cost: model.bigNumber().nullable(),
  // Snapshot of variant.metadata.qb_avg_cost_synced_at at issue time.
  // Lets reports show cost freshness ("based on a sync from N days ago").
  average_unit_cost_synced_at: model.dateTime().nullable(),
});

export default PosInvoiceItem;
