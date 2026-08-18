import { model } from "@medusajs/utils";

/**
 * A Vendor Bill captures the actual supplier invoice for a PO receipt,
 * including commission (sourcing agent fee), freight, and tariff charges
 * that make up the landed cost of imported goods.
 *
 * Lifecycle:
 *   draft     → created from receipt lines; fields can be freely edited
 *   confirmed → landed costs calculated and distributed to lines;
 *               product_variant.metadata.avg_landed_cost_cents updated
 *   synced    → future: QB Vendor Bill Add completed
 *
 * One receipt = at most one vendor bill (purchase_order_receipt_id is UNIQUE).
 *
 * Commission modes:
 *   percent → agent fee is commission_rate_bps / 10000 × unit_cost per unit
 *   fixed   → total commission_amount_cents split evenly across all units
 *
 * Freight distribution: CBM-weighted (cbm_per_unit × qty / total_cbm)
 * Tariff distribution:  Cost-weighted  (unit_cost × qty / total_cost)
 */
export const VendorBill = model.define("vendor_bill", {
  id: model.id({ prefix: "vb" }).primaryKey(),

  // Sequential human-readable ID assigned at creation (VB-XXXX)
  number: model.text().nullable(),

  // Regular bills may be filled from a PO/receipt. Service/freight/tariff bills
  // can be created independently and linked to a regular bill later.
  purchase_order_receipt_id: model.text().nullable(),
  purchase_order_id: model.text().nullable(),

  // Vendor is selected directly for every bill type. Regular bills may still
  // be filled from a PO, but the bill keeps its own vendor snapshot.
  vendor_id: model.text().nullable(),
  vendor_name_snapshot: model.text().nullable(),
  vendor_qb_list_id_snapshot: model.text().nullable(),

  bill_type: model.text().default("regular"), // regular | service | freight | tariff

  // Lifecycle
  status: model.text().default("draft"), // draft | confirmed | synced

  // Commission (sourcing agent fee)
  commission_mode: model.text().default("percent"), // percent | fixed
  commission_rate_bps: model.number().default(0), // 1500 = 15.00%
  commission_amount_cents: model.number().default(0), // used when mode=fixed
  commission_invoice_number: model.text().nullable(),
  service_vendor_bill_id: model.text().nullable(),

  // Freight
  freight_included: model.boolean().default(false),
  freight_amount_cents: model.number().default(0),
  freight_invoice_number: model.text().nullable(),
  freight_vendor_bill_id: model.text().nullable(),

  // Tariff / duty
  tariff_included: model.boolean().default(false),
  tariff_amount_cents: model.number().default(0),
  tariff_number: model.text().nullable(),
  tariff_vendor_bill_id: model.text().nullable(),

  // Sales tax the vendor charged on THIS invoice (US vendors that bill us tax
  // instead of honouring a resale certificate). Unlike commission/freight/
  // tariff there is no linked sibling bill: the tax is a line of the same
  // vendor document, so a single header amount copied off that document is
  // the whole input — no `_included` flag, 0 means "no tax".
  //
  // It capitalizes into the landed unit cost (non-recoverable tax on goods for
  // resale is part of acquisition cost) AND ships to QuickBooks as its own
  // positive ExpenseLine, because QBXML BillAdd has no header tax field —
  // ExpenseLineAdd / ItemLineAdd are the only slots a Bill has.
  tax_amount_cents: model.number().default(0),
  // Snapshot of the QB COGS account the tax posts to, resolved from qb_account
  // at save time. Snapshotted (not resolved at dispatch) so a chart-of-accounts
  // rename can never silently retarget an already-saved bill.
  tax_account_list_id: model.text().nullable(),

  // Vendor's own reference / PI number for this shipment
  reference_id: model.text().nullable(),

  // Date printed on the vendor document. This is intentionally separate from
  // created_at, which only means when we entered it in the system.
  document_date: model.dateTime().nullable(),

  // Free-text notes
  notes: model.text().nullable(),

  // Confirmation audit
  confirmed_at: model.dateTime().nullable(),
  confirmed_by_user_id: model.text().nullable(),

  // QuickBooks sync (Phase 0 — dormant; columns promoted from
  // Migration20260429000000 + new columns added here). See
  // docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.1.
  qb_txn_id: model.text().nullable(), // QB Bill TxnID once synced/adopted
  qb_edit_sequence: model.text().nullable(), // fresh EditSequence for BillMod/TxnDel
  qb_ref_number: model.text().nullable(), // QB RefNumber = vendor invoice # (reference_id)
  qb_amount_due_cents: model.number().nullable(),
  qb_is_paid: model.boolean().default(false),
  qb_balance_remaining_cents: model.number().nullable(),
  qb_payment_checked_at: model.dateTime().nullable(),
  // Set when a BillQuery proves the linked QB document is GONE (QB answers
  // statusCode 500 "required element could not be found" for both its TxnID and
  // its RefNumber) — i.e. someone deleted the Bill inside QuickBooks Desktop.
  // A deleted document never comes back on its own, so this is a terminal fact,
  // not a retryable failure: the hourly payment monitor skips marked bills, which
  // is what stops one permanently-failed pipeline row per hour, forever. Cleared
  // by an explicit human re-check (POST /admin/vendor-bills/:id/check-payment).
  qb_missing_in_qb_at: model.dateTime().nullable(),
  qb_synced_at: model.dateTime().nullable(), // when the Bill landed in QB
  qb_source: model.text().nullable(), // 'owned' | 'adopted'
  // China-agent regular Bills have negative QB Expense lines that clear the
  // positive Service/Freight/Tariff bills. They are not landed-cost input rows,
  // but BillMod must preserve them by their own QB TxnLineID.
  qb_clearing_lines: model.json().nullable(),

  // Payment terms. `payment_terms_days` is what the Due Date is computed from;
  // `payment_terms_name` records WHICH catalog term produced it. Both are
  // needed: two terms can share a day count ("Due on Receipt" and "Prepaid" are
  // both 0; "Net 30" and "Net-30" are both 30 and are distinct terms in the
  // company file), so the number alone cannot round-trip a selection.
  payment_terms_days: model.number().nullable(),
  payment_terms_name: model.text().nullable(),
  due_date: model.dateTime().nullable(),

  // Freight allocation basis: which weight vector `computeLandedLines` uses to
  // spread the freight pool across product lines. NULL = legacy policy — the
  // freight amount is captured as an ExpenseLine of pure expense and is NOT
  // capitalized into item cost. A non-null value ("units" | "value" | "cbm")
  // means freight IS capitalized into the landed cost of the items using that
  // basis, frozen at confirm time (same freeze discipline as cbm_per_unit).
  freight_allocation_basis: model.text().nullable(),
});
