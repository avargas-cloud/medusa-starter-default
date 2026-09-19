/**
 * Cash Close — pure classification of one payment/application. No DB, no
 * Date-timezone math (the loaders in `load-day.ts` already resolve every ET
 * date to a plain `YYYY-MM-DD` string before it reaches here) so this file
 * is trivial to unit-test with fixtures. See `types.ts` for the
 * classification rules this implements verbatim. Totals/ladder assembly
 * lives in `totals.ts` to keep this file under the 300-line cap.
 */
import type {
  CashCloseApplicationRef,
  CashCloseBucket,
  CashCloseHold,
  CashClosePaymentRow,
  CashCloseTenderGroup,
} from "./types";
import { getPaymentSource, receiptMethodLabel, tenderKey } from "./tender-label";
import type { RawPayment, RawPaymentApplication } from "./load-day";

const EMPTY_BY_BUCKET: Record<CashCloseBucket, number> = {
  invoice_today: 0,
  invoice_earlier: 0,
  order_deposit: 0,
  estimate_deposit: 0,
};

/** Tax share of an application to an invoice: tax × applied / total, to the
 * cent. A partial payment carries a proportional slice of the invoice's tax. */
function prorateInvoiceTax(app: RawPaymentApplication): number {
  const total = app.invoice_total_cents ?? 0;
  const tax = app.invoice_tax_cents ?? 0;
  if (total <= 0 || tax <= 0) return 0;
  return Math.round((tax * app.amount_applied_cents) / total);
}

function classifyApplication(
  app: RawPaymentApplication,
  day: string
): CashCloseApplicationRef {
  if (app.invoice_id) {
    if (app.invoice_issued_day === day) {
      return {
        bucket: "invoice_today",
        amount_cents: app.amount_applied_cents,
        document_label: `IN-${app.invoice_number ?? app.invoice_id}`,
        document_kind: "invoice",
        document_id: app.invoice_id,
        note: null,
        tax_cents: prorateInvoiceTax(app),
      };
    }
    if (app.invoice_issued_day && app.invoice_issued_day < day) {
      return {
        bucket: "invoice_earlier",
        amount_cents: app.amount_applied_cents,
        document_label: `IN-${app.invoice_number ?? app.invoice_id}`,
        document_kind: "invoice",
        document_id: app.invoice_id,
        note: null,
        tax_cents: prorateInvoiceTax(app),
      };
    }
    // issued_at > D (or somehow unresolved): the invoice exists now but
    // didn't on day D — the money was an order deposit on D.
    return {
      bucket: "order_deposit",
      amount_cents: app.amount_applied_cents,
      document_label: app.order_display_id
        ? `ORD-${app.order_display_id}`
        : `IN-${app.invoice_number ?? app.invoice_id}`,
      document_kind: "order",
      document_id: app.order_id ?? app.invoice_id,
      note: app.invoice_issued_day
        ? `invoiced IN-${app.invoice_number ?? ""} on ${app.invoice_issued_day}`
        : null,
      tax_cents: 0,
    };
  }
  if (app.order_id) {
    return {
      bucket: "order_deposit",
      amount_cents: app.amount_applied_cents,
      document_label: `ORD-${app.order_display_id ?? app.order_id}`,
      document_kind: "order",
      document_id: app.order_id,
      note: null,
      tax_cents: 0,
    };
  }
  // An active application with neither invoice_id nor order_id has nothing
  // to classify against — surfaced as invoice_today with the payment itself
  // as the document rather than silently dropping the money.
  return {
    bucket: "invoice_today",
    amount_cents: app.amount_applied_cents,
    document_label: "—",
    document_kind: "invoice",
    document_id: "",
    note: "unresolved application (no invoice or order)",
    tax_cents: 0,
  };
}

function parseHold(
  metadata: Record<string, unknown> | null | undefined
): CashCloseHold | null {
  const raw = metadata?.cash_close_hold;
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (h.kind !== "deposit" && h.kind !== "credit") return null;
  return {
    kind: h.kind,
    note: typeof h.note === "string" ? h.note : null,
    by: typeof h.by === "string" ? h.by : "",
    by_name: typeof h.by_name === "string" ? h.by_name : null,
    at: typeof h.at === "string" ? h.at : "",
  };
}

export function classifyPayment(
  row: RawPayment,
  day: string
): CashClosePaymentRow {
  const isStoreCredit = row.type === "credit_memo";
  const applications: CashCloseApplicationRef[] = [];
  let appliedTotal = 0;

  if (row.applications.length > 0) {
    for (const app of row.applications) {
      const ref = classifyApplication(app, day);
      applications.push(ref);
      appliedTotal += ref.amount_cents;
    }
  } else if (row.linked_order_id && row.linked_order_is_draft === true) {
    // estimate_deposit (types.ts): no active application, and the linked
    // order is still a draft (estimate). // ATAJO: current draft state, not
    // state-as-of-D — a converted estimate re-links its deposit to the real
    // order, so this only affects days closed retroactively.
    applications.push({
      bucket: "estimate_deposit",
      amount_cents: row.amount_cents,
      document_label: `EST-${row.linked_order_display_id ?? row.linked_order_id}`,
      document_kind: "estimate",
      document_id: row.linked_order_id,
      note: null,
      tax_cents: 0,
    });
    appliedTotal += row.amount_cents;
  }

  const unappliedRaw = row.amount_cents - appliedTotal;
  const unappliedCents = unappliedRaw > 0 ? unappliedRaw : 0;
  const hold = parseHold(row.metadata);
  const unexplainedCents = hold ? 0 : unappliedCents;

  return {
    payment_id: row.payment_id,
    display_id: row.display_id,
    received_at: row.received_at,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_contact: row.customer_contact,
    method: row.method,
    card_brand: row.card_brand,
    tender_label: receiptMethodLabel(row.method, row.card_brand),
    tender_key: tenderKey(row.method, row.card_brand),
    is_store_credit: isStoreCredit,
    amount_cents: row.amount_cents,
    tax_cents: applications.reduce((s, a) => s + a.tax_cents, 0),
    surcharge_cents: row.surcharge_cents,
    applications,
    unapplied_cents: unappliedCents,
    hold,
    unexplained_cents: unexplainedCents,
    source: getPaymentSource(row.metadata, row.method),
  };
}

export function buildTenderGroups(
  rows: CashClosePaymentRow[]
): CashCloseTenderGroup[] {
  const groups = new Map<string, CashCloseTenderGroup>();
  for (const row of rows) {
    let group = groups.get(row.tender_key);
    if (!group) {
      group = {
        tender_key: row.tender_key,
        tender_label: row.tender_label,
        is_store_credit: row.is_store_credit,
        count: 0,
        amount_cents: 0,
        tax_cents: 0,
        surcharge_cents: 0,
        by_bucket: { ...EMPTY_BY_BUCKET },
        unapplied_cents: 0,
        rows: [],
      };
      groups.set(row.tender_key, group);
    }
    group.count += 1;
    group.amount_cents += row.amount_cents;
    group.tax_cents += row.tax_cents;
    group.surcharge_cents += row.surcharge_cents;
    group.unapplied_cents += row.unapplied_cents;
    for (const app of row.applications) {
      group.by_bucket[app.bucket] += app.amount_cents;
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) =>
    a.tender_label.localeCompare(b.tender_label)
  );
}
