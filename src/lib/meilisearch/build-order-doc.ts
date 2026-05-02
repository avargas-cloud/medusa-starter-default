/**
 * Builds a flat MeiliSearch document for the `orders` index.
 *
 * One doc per order, surfacing every field the POS /orders search bar
 * needs to match against (placeholder: "Search by #, customer, company,
 * email or phone…") plus the QB ref numbers that staff sometimes paste
 * straight into the search.
 *
 * The shape stays flat — Meili indexes nested objects but typo-tolerance
 * works best on top-level string attributes.
 */

export interface OrderForMeili {
  id: string;
  display_id: number | null;
  status: string | null;
  payment_status?: string | null;
  fulfillment_status?: string | null;
  email: string | null;
  total: number | string | null;
  canceled_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  metadata: Record<string, unknown> | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    company_name?: string | null;
  } | null;
  billing_address?: {
    company?: string | null;
    phone?: string | null;
  } | null;
  shipping_address?: {
    company?: string | null;
    phone?: string | null;
  } | null;
  sales_channel?: { id?: string | null; name?: string | null } | null;
}

export interface OrderMeiliDoc {
  id: string;
  display_id: number;
  display_id_str: string;
  document_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_phone_digits: string;
  company_name: string;
  qb_sales_order_ref: string;
  qb_invoice_refs: string[];
  status: string;
  payment_status: string;
  fulfillment_status: string;
  is_canceled: boolean;
  is_voided: boolean;
  is_web_order: boolean;
  sales_rep_initials: string;
  sales_channel_id: string;
  total_cents: number;
  created_at_ts: number;
  updated_at_ts: number;
}

const POS_SC_ID = process.env.NEXT_PUBLIC_SALES_CHANNEL_ID || "";

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

export function buildOrderDoc(order: OrderForMeili): OrderMeiliDoc {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  const customer = order.customer || {};
  const billing = order.billing_address || {};
  const shipping = order.shipping_address || {};

  const firstName = asString(customer.first_name);
  const lastName = asString(customer.last_name);
  const customerName = [firstName, lastName].filter(Boolean).join(" ");
  const customerEmail = (
    asString(customer.email) || asString(order.email)
  ).toLowerCase();
  const customerPhone =
    asString(customer.phone) ||
    asString(billing.phone) ||
    asString(shipping.phone);
  const companyName =
    asString(customer.company_name) ||
    asString(billing.company) ||
    asString(shipping.company);

  // Document number → "S10090" (custom field assigned by document-number-subscriber)
  const documentNumber = asString(meta.document_number);

  // Sales rep — payload is { name, initials } or a string
  const salesRepRaw = meta.sales_rep;
  let salesRepInitials = "";
  if (salesRepRaw && typeof salesRepRaw === "object") {
    salesRepInitials = asString((salesRepRaw as any).initials);
  } else if (typeof salesRepRaw === "string") {
    salesRepInitials = salesRepRaw;
  }

  // QB refs — sales order singular + invoices array
  const qbSO = (meta.qb_sales_order || {}) as Record<string, unknown>;
  const qbSalesOrderRef = asString(qbSO.ref_number);
  const qbInvoicesArr = Array.isArray(meta.qb_invoices)
    ? (meta.qb_invoices as Array<Record<string, unknown>>)
    : [];
  const qbInvoiceRefs = qbInvoicesArr
    .map((inv) => asString(inv?.ref_number))
    .filter(Boolean);

  const isCanceled = order.canceled_at != null;
  const isVoided =
    typeof meta.voided_at === "string" || meta.voided_at instanceof Date;

  // A "web order" in this codebase is anything from a sales channel other
  // than the POS one. The frontend's isWebOrder() helper uses the same
  // logic.
  const salesChannelId = asString(order.sales_channel?.id);
  const isWebOrder = !!salesChannelId && salesChannelId !== POS_SC_ID;

  const displayId = order.display_id ?? 0;

  return {
    id: order.id,
    display_id: displayId,
    display_id_str: String(displayId),
    document_number: documentNumber,
    customer_name: customerName,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    customer_phone_digits: customerPhone.replace(/\D/g, ""),
    company_name: companyName,
    qb_sales_order_ref: qbSalesOrderRef,
    qb_invoice_refs: qbInvoiceRefs,
    status: asString(order.status),
    payment_status: asString(order.payment_status),
    fulfillment_status: asString(order.fulfillment_status),
    is_canceled: isCanceled,
    is_voided: isVoided,
    is_web_order: isWebOrder,
    sales_rep_initials: salesRepInitials,
    sales_channel_id: salesChannelId,
    total_cents: Math.round(asNum(order.total) * 100),
    created_at_ts: ts(order.created_at),
    updated_at_ts: ts(order.updated_at),
  };
}
