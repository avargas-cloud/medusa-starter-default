/**
 * Builds a flat MeiliSearch document for the `pos_invoices` index.
 *
 * One doc per pos_invoice, denormalized with the linked order's
 * display_id + document_number and the customer's profile so the
 * /invoices search can find a fiscal invoice via its underlying order
 * number ("S10090") or via any customer attribute.
 */

export interface PosInvoiceForMeili {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string;
  status: string | null;
  payment_method: string | null;
  card_brand: string | null;
  notes: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  balance_due: number | string | null;
  voided_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface OrderRefForMeili {
  display_id: number | null;
  metadata: Record<string, unknown> | null;
}

export interface CustomerRefForMeili {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company_name?: string | null;
}

export interface PosInvoiceMeiliDoc {
  id: string;
  invoice_number: string;
  invoice_number_str: string;
  order_id: string;
  order_display_id: number;
  order_display_id_str: string;
  order_document_number: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_phone_digits: string;
  company_name: string;
  qb_invoice_ref: string;
  payment_method: string;
  card_brand: string;
  notes: string;
  status: string;
  has_balance: boolean;
  total_cents: number;
  balance_cents: number;
  created_at_ts: number;
  updated_at_ts: number;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function ts(v: Date | string | null | undefined): number {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function buildPosInvoiceDoc(
  invoice: PosInvoiceForMeili,
  order: OrderRefForMeili | null,
  customer: CustomerRefForMeili | null
): PosInvoiceMeiliDoc {
  const customerName = [
    asString(customer?.first_name),
    asString(customer?.last_name),
  ]
    .filter(Boolean)
    .join(" ");
  const customerPhone = asString(customer?.phone);
  const orderMeta = (order?.metadata || {}) as Record<string, unknown>;

  // Pull QB invoice ref from the order's qb_invoices array. The pos_invoice
  // is keyed to a fulfillment_id, so the matching qb_invoices entry is
  // whichever has fulfillment_id === invoice.fulfillment_id; absent that,
  // fall back to the most recent ref_number on the order.
  const qbInvoicesArr = Array.isArray(orderMeta.qb_invoices)
    ? (orderMeta.qb_invoices as Array<Record<string, unknown>>)
    : [];
  const qbInvoiceRef =
    qbInvoicesArr
      .map((inv) => asString(inv?.ref_number))
      .filter(Boolean)
      .join(" ") || asString(orderMeta.qb_invoice_ref_num);

  const orderDisplayId = order?.display_id ?? 0;
  const balanceCents = Math.round(asNum(invoice.balance_due) * 100);

  return {
    id: invoice.id,
    invoice_number: invoice.invoice_number,
    invoice_number_str: invoice.invoice_number,
    order_id: invoice.order_id,
    order_display_id: orderDisplayId,
    order_display_id_str: String(orderDisplayId),
    order_document_number: asString(orderMeta.document_number),
    customer_id: invoice.customer_id,
    customer_name: customerName,
    customer_email: asString(customer?.email).toLowerCase(),
    customer_phone: customerPhone,
    customer_phone_digits: customerPhone.replace(/\D/g, ""),
    company_name: asString(customer?.company_name),
    qb_invoice_ref: qbInvoiceRef,
    payment_method: asString(invoice.payment_method),
    card_brand: asString(invoice.card_brand),
    notes: asString(invoice.notes),
    status: asString(invoice.status),
    has_balance: balanceCents > 0,
    total_cents: Math.round(asNum(invoice.total) * 100),
    balance_cents: balanceCents,
    created_at_ts: ts(invoice.created_at),
    updated_at_ts: ts(invoice.updated_at),
  };
}
