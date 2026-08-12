/**
 * src/modules/price-change/models/price-change-batch.ts
 * Header for a bulk price/cost change submitted for manager approval.
 *
 * Lifecycle:
 *   draft     → cashier is still editing (autosaved); nothing is validated
 *               strictly yet, no submitted_at
 *   submitted → cashier/manager submitted a batch of rows, awaiting review
 *   approved  → the money change was applied (writes + QB enqueue)
 *   rejected  → terminal; nothing was written
 *
 * Money fields on the LINE (not here) use `model.bigNumber()`, same as
 * `pos_invoice_item.unit_price`/`average_unit_cost` in `invoices/` — the
 * closest structural analog for a dollar-denominated snapshot field. Unlike
 * `pos_invoice`/`pos_credit_memo` (which store CENTS per the repo-wide POS
 * money convention), these dollars mirror `price.amount` and
 * `product_variant.metadata.purchase_cost`, the two sources they snapshot —
 * both already decimal dollars, never cents.
 */
import { model } from "@medusajs/utils";

import PriceChangeLine from "./price-change-line";

const PriceChangeBatch = model.define("price_change_batch", {
  id: model.id({ prefix: "pcb" }).primaryKey(),

  // Sequential, gapless, human-readable number — claimed from the
  // `price_change_batch` row in `document_number_counter` INSIDE the same
  // transaction that creates the batch (see api/admin/pos/price-batches
  // POST), same pattern as `medusa_invoice`/`qb_invoice`/`qb_sales_receipt`
  // in lib/invoices/document-numbering.ts. Nullable only for the transition —
  // every batch created from the migration below onward always has one. The
  // display string (`PA-<display_number>`) is assembled by the frontend.
  display_number: model.number().nullable(),

  status: model.text().default("submitted"), // 'draft' | 'submitted' | 'approved' | 'rejected'
  note: model.text().nullable(),

  created_by_user_id: model.text(),
  created_by_email: model.text(), // snapshot — survives a later user edit/removal

  // Nullable: a `draft` has no submitted_at until POST /:id/submit sets it.
  submitted_at: model.dateTime().nullable(),

  reviewed_by_user_id: model.text().nullable(),
  reviewed_by_email: model.text().nullable(),
  reviewed_at: model.dateTime().nullable(),
  reject_reason: model.text().nullable(),

  line_count: model.number(),

  // Result summary written at approve time — { updated, qb_enqueued, skipped_qb }.
  applied_summary: model.json().nullable(),

  // Real ORM relation (see the line model's docstring for why it can't be a
  // plain text FK): required so batch + lines can be created in ONE tx.
  lines: model.hasMany(() => PriceChangeLine, { mappedBy: "batch" }),
});

export default PriceChangeBatch;
