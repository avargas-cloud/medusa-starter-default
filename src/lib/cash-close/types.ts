/**
 * Cash Close — types and classification rules.
 *
 * A cash close answers one question for ONE business day (ET): where did every
 * dollar that came in go, and how was every dollar invoiced settled. It never
 * posts to the GL and never sends anything to QuickBooks: it classifies and
 * records. The printed close is a frozen SNAPSHOT (`pos_cash_close.snapshot`),
 * so a reprint shows the same figures the accountant filed, never a recompute.
 *
 * All money is integer CENTS (customer_payment.amount, payment_application
 * .amount_applied, pos_invoice.total are already cents in this schema).
 *
 * ── Day membership ──────────────────────────────────────────────────────────
 *  payment  ∈ day D  ⇔  received_at AT TIME ZONE 'America/New_York' :: date = D
 *  invoice  ∈ day D  ⇔  issued_at   AT TIME ZONE 'America/New_York' :: date = D
 *  credit memo ∈ D   ⇔  completed_at (ET date) = D
 *  refund   ∈ day D  ⇔  COALESCE(metadata.refund_txn_date, refunded_at ET date) = D
 *    (a card refund leaves the processor on refund_txn_date, days after the
 *     click — 3806/4994 in prod: refunded 09/11–12, settled 09/15)
 *  order / estimate issued ∈ D ⇔ "order".created_at (ET date) = D;
 *    estimate = is_draft_order, order = NOT is_draft_order
 *
 * ── Payments received (cash side) ───────────────────────────────────────────
 *  Only `type = 'payment'` rows, status NOT IN ('voided'). `type = 'credit_memo'`
 *  rows are store credit used as tender — NOT money in — they are listed in a
 *  separate "Store credit (not cash)" group and excluded from the received total.
 *  amount = customer_payment.amount (without fee); surcharge = surcharge_cents,
 *  fee income, shown apart and never part of "received".
 *
 *  Each active application (voided_at IS NULL, deleted_at IS NULL) of a day-D
 *  payment lands in exactly one bucket, evaluated AS OF END OF DAY D:
 *    invoice_today      invoice_id set AND invoice.issued_at ET date = D
 *    invoice_earlier    invoice_id set AND issued_at < D        (AR collected)
 *    order_deposit      order_id set AND (invoice_id NULL
 *                         OR invoice.issued_at > D)   ← 5072/IN-21844 case: the
 *                       money was an order deposit on D even though the invoice
 *                       exists now
 *    estimate_deposit   no active application, and locked_order_id /
 *                       metadata.order_id points to a draft order (is_draft_order)
 *                       // ATAJO: current draft state, not state-as-of-D; a
 *                       // converted estimate re-links its deposit to the order,
 *                       // so this only affects days closed retroactively.
 *  unapplied = amount − Σ applied (all buckets), when > 0:
 *    held_deposit       metadata.cash_close_hold.kind = 'deposit'
 *    held_credit        metadata.cash_close_hold.kind = 'credit'
 *    unexplained        no hold  → the ONLY thing that makes a day Not balanced
 *
 * ── Sales invoiced (sales side), for invoices ∈ D, status ≠ voided ──────────
 *  paid_today         Σ applications from day-D payments (type payment)
 *  paid_earlier       Σ applications from payments received BEFORE D
 *  paid_store_credit  Σ applications from type='credit_memo' payments (any day)
 *  on_account         invoice.total − Σ all active applications  (AR up)
 *  credit_memos_today Σ pos_credit_memo.total completed on D, status ≠ voided
 *    (refund_method 'refund' also produces a refund on the cash side; a
 *     'store_credit' CM only touches the sales side)
 *
 * ── The tie (accountant's ladder) ───────────────────────────────────────────
 *  invoiced
 *   − paid_earlier − paid_store_credit − on_account − credit_memos_today
 *   + invoice_earlier (from cash side) + order_deposit + estimate_deposit
 *   + held_deposit + held_credit + unexplained
 *   − refunds_paid_out
 *  = received − refunds_paid_out  (net cash)
 *  It ties by construction; `verify-cash-close.ts` asserts it to the cent.
 *
 * ── Balanced ────────────────────────────────────────────────────────────────
 *  balanced ⇔ unexplained_cents = 0. Numbering (CC-####) is only granted to a
 *  balanced close (operator decision 09/18/2026); an unbalanced day prints as
 *  DRAFT without number and stores nothing.
 */

export type CashCloseBucket =
  | "invoice_today"
  | "invoice_earlier"
  | "order_deposit"
  | "estimate_deposit";

export type HoldKind = "deposit" | "credit";

/** Stored on customer_payment.metadata.cash_close_hold (read-modify-write). */
export interface CashCloseHold {
  kind: HoldKind;
  note: string | null;
  by: string; // actor id
  by_name: string | null;
  at: string; // ISO
}

export interface CashCloseApplicationRef {
  bucket: CashCloseBucket;
  amount_cents: number;
  /** IN-21847 / ORD-4710 / EST-5312 style label for the UI and the print. */
  document_label: string;
  document_kind: "invoice" | "order" | "estimate";
  document_id: string;
  /** For order_deposit whose invoice exists now: "invoiced IN-21844 on 09/18". */
  note: string | null;
}

export interface CashClosePaymentRow {
  payment_id: string;
  display_id: number;
  received_at: string;
  customer_id: string;
  customer_name: string; // company or first+last
  customer_contact: string | null; // person under the company, if distinct
  method: string;
  card_brand: string | null;
  /** receiptMethodLabel-compatible: "Visa · Debit Card", "Cash", "Zelle"… */
  tender_label: string;
  /** Group key for the tender rows: `${method}|${card_brand ?? ''}` */
  tender_key: string;
  is_store_credit: boolean; // type = 'credit_memo'
  amount_cents: number;
  surcharge_cents: number;
  applications: CashCloseApplicationRef[];
  unapplied_cents: number;
  hold: CashCloseHold | null;
  /** unexplained = unapplied and no hold */
  unexplained_cents: number;
  source: string | null; // "Terminal" | "Online" | "Cash Drawer" | …
}

export interface CashCloseTenderGroup {
  tender_key: string;
  tender_label: string;
  is_store_credit: boolean;
  count: number;
  amount_cents: number;
  surcharge_cents: number;
  by_bucket: Record<CashCloseBucket, number>;
  unapplied_cents: number;
  rows: CashClosePaymentRow[];
}

export interface CashCloseInvoiceRow {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  total_cents: number;
  paid_today_cents: number;
  paid_earlier_cents: number;
  paid_store_credit_cents: number;
  on_account_cents: number;
  /** "Pmt 5048" | "Deposit 09/16" | "Store credit" | "On account" */
  settled_by: string;
}

export interface CashCloseRefundRow {
  payment_id: string;
  display_id: number;
  customer_name: string;
  amount_cents: number;
  method: string;
  card_brand: string | null;
  tender_label: string;
  /** Credit memo number when the refund came from a CM, else null */
  credit_memo_number: string | null;
}

export interface CashCloseTotals {
  received_cents: number; // cash side, type payment, excl. voided
  received_count: number;
  surcharge_cents: number;
  store_credit_tender_cents: number; // credit_memo-type payments used as tender
  refunds_paid_out_cents: number;
  refunds_count: number;
  invoiced_cents: number;
  invoiced_count: number;
  credit_memos_today_cents: number;
  credit_memos_count: number;
  estimates_issued_count: number;
  estimates_issued_cents: number;
  orders_issued_count: number;
  orders_issued_cents: number;
  // cash side buckets
  invoice_today_cents: number;
  invoice_earlier_cents: number;
  order_deposit_cents: number;
  estimate_deposit_cents: number;
  held_deposit_cents: number;
  held_credit_cents: number;
  unexplained_cents: number;
  unexplained_count: number;
  // sales side
  paid_today_cents: number;
  paid_earlier_cents: number;
  paid_store_credit_cents: number;
  on_account_cents: number;
  on_account_count: number;
}

export interface CashCloseLadderLine {
  key: string;
  label: string;
  detail: string | null;
  /** signed cents; zero lines are still emitted so the reader sees them checked */
  cents: number;
  kind: "start" | "adjust" | "end";
}

export interface CashCloseSnapshot {
  version: 1;
  business_day: string; // YYYY-MM-DD (ET)
  computed_at: string;
  balanced: boolean;
  totals: CashCloseTotals;
  tenders: CashCloseTenderGroup[];
  invoices: CashCloseInvoiceRow[];
  refunds: CashCloseRefundRow[];
  ladder: CashCloseLadderLine[];
}

export interface CashCloseRecord {
  id: string;
  number: string; // CC-0091
  business_day: string;
  balanced: true;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  snapshot: CashCloseSnapshot;
}
