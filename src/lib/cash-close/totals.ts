/**
 * Cash Close — totals, the ladder tie, and the full snapshot assembly.
 * Split out of `classify.ts` to keep both files under the repo's 300-line
 * cap; still pure (no DB, no wall-clock reads besides the `now` argument
 * `computeSnapshot` is handed).
 */
import type {
  CashCloseInvoiceRow,
  CashCloseLadderLine,
  CashCloseRefundRow,
  CashCloseSnapshot,
  CashClosePaymentRow,
  CashCloseTotals,
} from "./types";
import { receiptMethodLabel } from "./tender-label";
import { buildTenderGroups, classifyPayment } from "./classify";
import type {
  RawCreditMemo,
  RawInvoice,
  RawOrderEstimateAgg,
  RawPayment,
  RawRefund,
} from "./load-day";

export class CashCloseLadderMismatchError extends Error {
  constructor(
    public readonly sumOfLines: number,
    public readonly endCents: number
  ) {
    super(
      `CASH_CLOSE_LADDER_MISMATCH: sum of adjustments ${sumOfLines} !== end ${endCents}`
    );
    this.name = "CashCloseLadderMismatchError";
  }
}

export interface CashCloseDayRows {
  payments: RawPayment[];
  invoices: RawInvoice[];
  creditMemos: RawCreditMemo[];
  refunds: RawRefund[];
  orderEstimateAgg: RawOrderEstimateAgg;
}

/** "Pmt 5048" | "Deposit 09/16" | "Store credit" | "On account" */
function settledByLabel(
  invoice: RawInvoice,
  paidToday: number,
  paidEarlier: number,
  paidStoreCredit: number,
  onAccount: number
): string {
  const paymentApps = invoice.applications.filter(
    (a) => a.payment_type === "payment"
  );
  if (paymentApps.length === 1 && paidStoreCredit === 0 && onAccount === 0) {
    return `Pmt ${paymentApps[0]!.payment_display_id}`;
  }
  if (paidToday === 0 && paidEarlier > 0 && paidStoreCredit === 0) {
    const day = paymentApps[0]?.payment_day;
    return day ? `Deposit ${day.slice(5).replace("-", "/")}` : "Deposit";
  }
  if (paidStoreCredit > 0 && paidToday === 0 && paidEarlier === 0 && onAccount === 0) {
    return "Store credit";
  }
  if (onAccount > 0 && paidToday === 0 && paidEarlier === 0 && paidStoreCredit === 0) {
    return "On account";
  }
  return paymentApps.length > 1 ? "Multiple payments" : "Mixed";
}

export function buildInvoiceRows(
  invoices: RawInvoice[],
  day: string
): CashCloseInvoiceRow[] {
  return invoices.map((invoice) => {
    let paidToday = 0;
    let paidEarlier = 0;
    let paidStoreCredit = 0;
    let allApplied = 0;
    for (const app of invoice.applications) {
      allApplied += app.amount_applied_cents;
      if (app.payment_type === "credit_memo") {
        paidStoreCredit += app.amount_applied_cents;
      } else if (app.payment_day === day) {
        paidToday += app.amount_applied_cents;
      } else {
        paidEarlier += app.amount_applied_cents;
      }
    }
    const onAccount = invoice.total_cents - allApplied;
    return {
      invoice_id: invoice.invoice_id,
      invoice_number: invoice.invoice_number,
      customer_name: invoice.customer_name,
      total_cents: invoice.total_cents,
      paid_today_cents: paidToday,
      paid_earlier_cents: paidEarlier,
      paid_store_credit_cents: paidStoreCredit,
      on_account_cents: onAccount,
      settled_by: settledByLabel(invoice, paidToday, paidEarlier, paidStoreCredit, onAccount),
    };
  });
}

export function buildRefundRows(refunds: RawRefund[]): CashCloseRefundRow[] {
  return refunds.map((r) => ({
    payment_id: r.payment_id,
    display_id: r.display_id,
    customer_name: r.customer_name,
    amount_cents: r.amount_cents,
    method: r.method,
    card_brand: r.card_brand,
    tender_label: receiptMethodLabel(r.method, r.card_brand),
    credit_memo_number: r.credit_memo_number,
  }));
}

export function buildTotals(
  paymentRows: CashClosePaymentRow[],
  invoiceRows: CashCloseInvoiceRow[],
  creditMemos: RawCreditMemo[],
  refunds: RawRefund[],
  orderEstimateAgg: RawOrderEstimateAgg
): CashCloseTotals {
  let received_cents = 0;
  let received_count = 0;
  let surcharge_cents = 0;
  let store_credit_tender_cents = 0;
  let invoice_today_cents = 0;
  let invoice_earlier_cents = 0;
  let order_deposit_cents = 0;
  let estimate_deposit_cents = 0;
  let held_deposit_cents = 0;
  let held_credit_cents = 0;
  let unexplained_cents = 0;
  let unexplained_count = 0;

  for (const row of paymentRows) {
    if (row.is_store_credit) {
      store_credit_tender_cents += row.amount_cents;
      continue;
    }
    received_cents += row.amount_cents;
    received_count += 1;
    surcharge_cents += row.surcharge_cents;
    for (const app of row.applications) {
      if (app.bucket === "invoice_today") invoice_today_cents += app.amount_cents;
      else if (app.bucket === "invoice_earlier") invoice_earlier_cents += app.amount_cents;
      else if (app.bucket === "order_deposit") order_deposit_cents += app.amount_cents;
      else if (app.bucket === "estimate_deposit") estimate_deposit_cents += app.amount_cents;
    }
    if (row.hold?.kind === "deposit") held_deposit_cents += row.unapplied_cents;
    else if (row.hold?.kind === "credit") held_credit_cents += row.unapplied_cents;
    else if (row.unexplained_cents > 0) {
      unexplained_cents += row.unexplained_cents;
      unexplained_count += 1;
    }
  }

  const invoiced_cents = invoiceRows.reduce((s, i) => s + i.total_cents, 0);
  const paid_today_cents = invoiceRows.reduce((s, i) => s + i.paid_today_cents, 0);
  const paid_earlier_cents = invoiceRows.reduce((s, i) => s + i.paid_earlier_cents, 0);
  const paid_store_credit_cents = invoiceRows.reduce((s, i) => s + i.paid_store_credit_cents, 0);
  const on_account_rows = invoiceRows.filter((i) => i.on_account_cents > 0);
  const on_account_cents = on_account_rows.reduce((s, i) => s + i.on_account_cents, 0);

  const liveCreditMemos = creditMemos.filter((cm) => cm.status !== "voided");
  const credit_memos_today_cents = liveCreditMemos.reduce((s, cm) => s + cm.total_cents, 0);
  const refunds_paid_out_cents = refunds.reduce((s, r) => s + r.amount_cents, 0);

  return {
    received_cents,
    received_count,
    surcharge_cents,
    store_credit_tender_cents,
    refunds_paid_out_cents,
    refunds_count: refunds.length,
    invoiced_cents,
    invoiced_count: invoiceRows.length,
    credit_memos_today_cents,
    credit_memos_count: liveCreditMemos.length,
    estimates_issued_count: orderEstimateAgg.estimates_issued_count,
    estimates_issued_cents: orderEstimateAgg.estimates_issued_cents,
    orders_issued_count: orderEstimateAgg.orders_issued_count,
    orders_issued_cents: orderEstimateAgg.orders_issued_cents,
    invoice_today_cents,
    invoice_earlier_cents,
    order_deposit_cents,
    estimate_deposit_cents,
    held_deposit_cents,
    held_credit_cents,
    unexplained_cents,
    unexplained_count,
    paid_today_cents,
    paid_earlier_cents,
    paid_store_credit_cents,
    on_account_cents,
    on_account_count: on_account_rows.length,
  };
}

/**
 * The ladder walks from "invoiced today" to "net cash received". Credit memos
 * are deliberately NOT a line: a CM never moves cash by itself (the money only
 * leaves as a refund, which has its own line) and it does not change what was
 * invoiced today either — 09/18/2026 in prod: a $268.02 CM completed and used
 * as store credit on an EARLIER invoice broke the tie by exactly that amount
 * and the backend threw on every open of "today". `credit_memos_today_cents`
 * stays in the totals for the sales block, as information.
 */
export function buildLadder(totals: CashCloseTotals): CashCloseLadderLine[] {
  const lines: CashCloseLadderLine[] = [
    { key: "invoiced", label: "Invoiced", detail: null, cents: totals.invoiced_cents, kind: "start" },
    { key: "paid_earlier", label: "− Paid earlier (AR collected)", detail: null, cents: -totals.paid_earlier_cents, kind: "adjust" },
    { key: "paid_store_credit", label: "− Paid by store credit", detail: null, cents: -totals.paid_store_credit_cents, kind: "adjust" },
    { key: "on_account", label: "− On account", detail: null, cents: -totals.on_account_cents, kind: "adjust" },
    { key: "invoice_earlier", label: "+ Invoice earlier (cash collected on old invoices)", detail: null, cents: totals.invoice_earlier_cents, kind: "adjust" },
    { key: "order_deposit", label: "+ Order deposits", detail: null, cents: totals.order_deposit_cents, kind: "adjust" },
    { key: "estimate_deposit", label: "+ Estimate deposits", detail: null, cents: totals.estimate_deposit_cents, kind: "adjust" },
    { key: "held_deposit", label: "+ Held as deposit", detail: null, cents: totals.held_deposit_cents, kind: "adjust" },
    { key: "held_credit", label: "+ Held as credit", detail: null, cents: totals.held_credit_cents, kind: "adjust" },
    { key: "unexplained", label: "+ Unexplained", detail: null, cents: totals.unexplained_cents, kind: "adjust" },
    { key: "refunds_paid_out", label: "− Refunds paid out", detail: null, cents: -totals.refunds_paid_out_cents, kind: "adjust" },
  ];
  const sumOfLines = lines.reduce((s, l) => s + l.cents, 0);
  const endCents = totals.received_cents - totals.refunds_paid_out_cents;
  if (sumOfLines !== endCents) {
    throw new CashCloseLadderMismatchError(sumOfLines, endCents);
  }
  lines.push({ key: "end", label: "Net cash received", detail: null, cents: endCents, kind: "end" });
  return lines;
}

export function computeSnapshot(
  dayRows: CashCloseDayRows,
  day: string,
  now: Date
): CashCloseSnapshot {
  const paymentRows = dayRows.payments.map((p) => classifyPayment(p, day));
  const tenders = buildTenderGroups(paymentRows);
  const invoices = buildInvoiceRows(dayRows.invoices, day);
  const refunds = buildRefundRows(dayRows.refunds);
  const totals = buildTotals(
    paymentRows,
    invoices,
    dayRows.creditMemos,
    dayRows.refunds,
    dayRows.orderEstimateAgg
  );
  const ladder = buildLadder(totals);
  return {
    version: 1,
    business_day: day,
    computed_at: now.toISOString(),
    balanced: totals.unexplained_cents === 0,
    totals,
    tenders,
    invoices,
    refunds,
    ladder,
  };
}
