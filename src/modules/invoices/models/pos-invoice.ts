/**
 * src/modules/invoices/models/pos-invoice.ts
 * Core invoice entity.
 * One Medusa Order → multiple Fulfillments → one PosInvoice per dispatch.
 * Status lifecycle: draft → issued → paid → voided
 */

import { model } from "@medusajs/utils";

import InvoiceTracking from "./invoice-tracking";
import PosInvoiceItem from "./pos-invoice-item";

const PosInvoice = model.define("pos_invoice", {
  id: model.id().primaryKey(),
  invoice_number: model.text(), // INV-{order.display_id}-{seq}
  order_id: model.text(), // FK → Medusa Order (external)
  fulfillment_id: model.text().nullable(), // FK → Medusa Fulfillment (external)
  // How this invoice links to shipments. 'legacy_1to1' = pre-v2 rows where
  // fulfillment_id above is the (single) link and void may reverse it.
  // 'derived_v2' = every merchandise line carries order_line_item_id; dispatch
  // links live in order_delivery(invoice_id) and void NEVER reverses stock of
  // dispatched goods.
  shipment_link_mode: model.text().default("legacy_1to1"),
  customer_id: model.text(), // FK → Medusa Customer (external)
  status: model
    .enum([
      "draft",
      "issued",
      "partial",
      "paid",
      "voided",
      "partially_refunded",
      "refunded",
    ])
    .default("issued"),
  subtotal: model.bigNumber(), // in cents
  discount: model.bigNumber().default(0), // in cents
  shipping: model.number().default(0), // in cents (plain numeric in DB)
  tax: model.bigNumber(),
  untaxed_total: model.bigNumber(), // total − tax, pre-computed for reporting
  total: model.bigNumber(),
  amount_paid: model.bigNumber(),
  balance_due: model.bigNumber(),
  refunded_amount: model.bigNumber().default(0), // cumulative items refund from credit memos (cents)
  refunded_shipping: model.bigNumber().default(0), // cumulative shipping refund from credit memos (cents)
  payment_method: model.enum([
    // Canonical values — new writes should use these.
    "credit_card",
    "debit_card",
    "cash",
    "check",
    "ach",
    "zelle",
    "credit", // Store credit / credit memo — legacy meaning preserved.
    "mixed",
    // Legacy values — retained to read historical rows. Backfill normalizes
    // these to {credit_card|debit_card, card_brand: <brand>}.
    "card",
    "visa",
    "mastercard",
    "amex",
    "discover",
    "capital_one",
    "credit_memo",
  ]).nullable(),
  /**
   * Card network (visa, mastercard, amex, discover, capital_one) for card
   * payments. NULL for non-card methods (cash, check, zelle, ach) and for
   * debit-only transactions where we intentionally don't record the brand.
   */
  card_brand: model.text().nullable(),
  issued_at: model.dateTime().nullable(),
  paid_at: model.dateTime().nullable(),
  voided_at: model.dateTime().nullable(),
  void_reason: model.text().nullable(),
  notes: model.text().nullable(),
  created_by: model.text().nullable(), // admin user email/id
  shipping_address: model.json().nullable(), // snapshot of order.shipping_address at creation time
  metadata: model.json().nullable(), // Extensibility (QB ref, etc.)
  items: model.hasMany(() => PosInvoiceItem, { mappedBy: "invoice" }),
  tracking_links: model.hasMany(() => InvoiceTracking, { mappedBy: "invoice" }),
});

export default PosInvoice;
