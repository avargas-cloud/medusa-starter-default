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
  // Draft orders back POS estimates. They must never surface in the /orders
  // tabs (estimates have their own page sourced from /admin/draft-orders).
  is_draft_order?: boolean | null;
  payment_status?: string | null;
  fulfillment_status?: string | null;
  email: string | null;
  total: number | string | null;
  canceled_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  metadata: Record<string, unknown> | null;
  summary?: {
    current_order_total?: number | string | null;
  } | null;
  payment_collections?: Array<{
    captured_amount?: number | string | null;
    refunded_amount?: number | string | null;
  }> | null;
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
  // Raw fulfillments rows so we can compute fulfillment_status ourselves.
  // query.graph({entity: "order", fields: ["fulfillment_status"]}) returns
  // nothing for that field — it's a derived value on the orders module
  // service, not a column. Computing it here keeps the Meili doc in sync
  // with what the POS UI shows.
  fulfillments?: Array<{
    packed_at?: Date | string | null;
    shipped_at?: Date | string | null;
    delivered_at?: Date | string | null;
    canceled_at?: Date | string | null;
  }> | null;
  // Line items + their fulfilled qty. Needed so computeFulfillmentStatus can
  // replicate Medusa's `hasUnfulfilledItems` guard: an order whose fulfillments
  // are all delivered is still only partially_delivered if any line item was
  // never (fully) fulfilled. Without these, a partial order reads as delivered.
  items?: Array<{
    quantity?: number | string | null;
    detail?: { fulfilled_quantity?: number | string | null } | null;
  }> | null;
}

/**
 * Effective payment status — mirrors the POS UI's getEffectivePaymentStatus()
 * (store-pos/app/(pos)/orders/utils.ts). The native Medusa `payment_status`
 * is NOT enough: a "deposited" or "fully_paid" order is derived from captured
 * payment-collection amounts + the referential_deposit metadata, not from the
 * native field. Tabs filter on these derived values, so they MUST be computed
 * at index time for Meili to return the same truth the UI shows.
 *
 * `captured` was removed from this scale on 2026-07-29. It was unreachable
 * here anyway — Medusa computes `payment_status` rather than storing it, so
 * query.graph delivers it empty at index time and the branch never fired, which
 * is why the POS's Captured payment filter returned nothing from the server.
 * Rather than teach the index to reproduce a value that answers a different
 * question ("the payments we took, we took successfully"), the POS dropped it:
 * it was redundant for 1069 of 1128 orders and hid a $24.5k balance on the
 * other 58. Both sides now classify purely by money in, so they agree.
 */
export type EffectivePaymentStatus =
  | "not_paid"
  | "deposited"
  | "fully_paid"
  | "voided";

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
  // Derived flags — computed identically to the POS UI helpers so each tab
  // maps to a single filterable boolean and Meili returns the true full set.
  effective_payment: EffectivePaymentStatus;
  is_unpaid: boolean;
  /**
   * The order is holding money that has not been used yet — a live deposit.
   *
   * A different question from `effective_payment`, which grades how COVERED the
   * order is. An order can be fully_paid and still hold a live deposit (paid in
   * full, invoiced only in part), and the operator's Deposited filter asks this
   * question, not that one. Before 2026-07-29 the two were indistinguishable
   * because the deposit field held every dollar, used or not.
   */
  has_deposit: boolean;
  // True for draft orders (POS estimates) — every /orders tab filters these out.
  is_draft: boolean;
  is_open: boolean;
  is_closed: boolean;
  is_separated: boolean;
  /**
   * Tri-state the Separated tab actually filters on.
   *
   * `is_separated` above stays the boolean mirror of `metadata.is_separated`,
   * which the separations route writes as `status === "full"` only. Filtering
   * the tab on it meant a partially separated order could never appear there —
   * two of the three live separations were invisible. Widening `is_separated`
   * instead would have made the indexed field and the metadata field of the
   * same name mean different things, which is how the fulfillment_status
   * divergence (S11417) happened; the tri-state gets its own name instead.
   *
   * Gated exactly like is_separated: a closed or fully invoiced order is no
   * longer awaiting separation, so it reads "none" whatever its rows say.
   */
  separation_state: "none" | "partial" | "full";
  is_canceled: boolean;
  is_voided: boolean;
  is_web: boolean;
  is_web_order: boolean;
  sales_rep_initials: string;
  sales_channel_id: string;
  total_cents: number;
  created_at_ts: number;
  // Mirrors POS UI getEffectiveDate(): falls back to metadata.order_placed_at
  // before created_at so the date-range filter on /admin/orders/counts matches
  // the dataset the orders page actually displays.
  effective_date_ts: number;
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

const OPEN_FULFILLMENT = new Set([
  "not_fulfilled",
  "partially_fulfilled",
  "partially_shipped",
  "partially_delivered",
]);
const CLOSED_FULFILLMENT = new Set(["fulfilled", "shipped", "delivered"]);

/** An estimate (POS `E####`), not a confirmed order. */
export function isDraftOrder(order: OrderForMeili): boolean {
  return order.is_draft_order === true || asString(order.status) === "draft";
}

/**
 * Whether this order belongs in the `orders` index at all.
 *
 * The index means CONFIRMED ORDERS. Its only three readers — orders/filter,
 * orders/counts, orders/search — every one of them hard-filters `is_draft =
 * false`, and the Estimates page never touches MeiliSearch: it queries Postgres
 * directly (`admin/draft-orders/filter`), exactly and without a row cap, because
 * an estimate's tabs come from `metadata->>'order_status'` — a column, not a
 * computed getter. Orders need the index precisely because THEIR tabs
 * (effective_payment, is_open) are derived values Postgres cannot filter on.
 *
 * So 258 estimate documents were being written, reconciled every 5 minutes and
 * audited nightly for no reader at all. Indexing them buys no reach and costs a
 * second copy that can disagree with the database — which is the failure this
 * index keeps producing.
 *
 * This also closes a real hole: `POST /admin/orders/:id/revert-to-draft` flips an
 * order back to an estimate. Without this predicate its document stayed behind,
 * still `is_draft = false`, still in the Open tab, describing an order that no
 * longer exists as one. Every writer must DELETE the document when this returns
 * false, not merely skip it.
 */
export function isIndexableOrder(order: OrderForMeili): boolean {
  return !isDraftOrder(order);
}

/**
 * Mirrors Medusa's order-module derivation of `fulfillment_status`. Needed
 * because query.graph silently drops the field — it isn't a real column,
 * just a computed getter on the orders module service. Without this, every
 * Meili doc had fulfillment_status="" so is_open and is_closed were both
 * false for all 591 orders → the Closed tab badge showed 0.
 */
export function computeFulfillmentStatus(
  fulfillments: OrderForMeili["fulfillments"],
  items?: OrderForMeili["items"]
): string {
  const active = (fulfillments ?? []).filter((f) => !f.canceled_at);
  if (active.length === 0) return "not_fulfilled";

  const delivered = active.filter((f) => !!f.delivered_at).length;
  const shipped = active.filter(
    (f) => !!f.shipped_at && !f.delivered_at
  ).length;
  const packed = active.filter(
    (f) => !!f.packed_at && !f.shipped_at && !f.delivered_at
  ).length;
  const total = active.length;

  // Mirror Medusa core (getLastFulfillmentStatus): a fully-delivered set of
  // fulfillments is still only partially_[STATUS] when any line item has not
  // been fully fulfilled — e.g. one fulfillment covers 20/140 of a line, the
  // other 120 were never fulfilled. Without this guard such an order reads as
  // "delivered" instead of "partially_delivered". If item data is unavailable
  // (older callers), default to false so behavior is unchanged.
  const hasUnfulfilledItems = (items ?? []).some((i) => {
    const ordered = Number(i?.quantity ?? 0);
    const fulfilled = Number(i?.detail?.fulfilled_quantity ?? 0);
    return fulfilled < ordered;
  });

  if (delivered > 0) {
    return delivered === total && !hasUnfulfilledItems
      ? "delivered"
      : "partially_delivered";
  }
  if (shipped + delivered > 0) {
    return shipped + delivered === total && !hasUnfulfilledItems
      ? "shipped"
      : "partially_shipped";
  }
  if (packed + shipped + delivered > 0) {
    return packed + shipped + delivered === total && !hasUnfulfilledItems
      ? "fulfilled"
      : "partially_fulfilled";
  }
  return "not_fulfilled";
}

// --- Effective payment computation (port of store-pos orders/utils.ts) ---

function getOrderTotal(order: OrderForMeili): number | null {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  const posTotal = asNum(meta.pos_total);
  if (posTotal > 0) return posTotal;

  const orderTotal = asNum(order.total);
  if (orderTotal > 0) return orderTotal;

  const summaryTotal = order.summary?.current_order_total;
  if (summaryTotal != null) {
    const summaryNum = asNum(summaryTotal);
    const captured = (order.payment_collections || []).reduce(
      (sum, pc) => sum + asNum(pc?.captured_amount),
      0
    );
    const ps = asString(order.payment_status);
    if (
      captured > summaryNum &&
      (ps === "captured" || ps === "partially_captured")
    ) {
      return captured;
    }
    return summaryNum;
  }
  return null;
}

/**
 * The order's money, in three numbers that never overlap.
 *
 *   getDepositAmount — money sitting on the order, NOT yet used  (Deposit)
 *   getPaidAmount    — money already consumed by invoices        (Paid Amt)
 *   getSettledAmount — the two together; decides whether the customer owes
 *
 * All three come from `order_money_projection`, mirrored into metadata by
 * recompute_order_money(). Until 2026-07-29 `getPaidAmount` was
 * `max(nativeCaptured, referential_deposit)` — one number answering two
 * questions, which is why a settled order showed the same value in Deposit and
 * Paid Amt, and why a consumed deposit still displayed as a deposit.
 *
 * Mirror of store-pos/app/(pos)/orders/utils.ts. These flags decide tab
 * membership server-side, so if the two drift the tab and its rows contradict.
 */
function getDepositAmount(order: OrderForMeili): number {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  const n = asNum(meta.referential_deposit);
  return n > 0 ? n : 0;
}

function getPaidAmount(order: OrderForMeili): number | null {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  if (meta.applied_total != null) {
    return asNum(meta.applied_total);
  }

  // No projection row yet — nothing in the finance ledger claims this order.
  // Fall back to what Medusa captured. Measured 2026-07-29 against production:
  // no order had captured MORE than the ledger applied.
  let nativePaid: number | null = null;
  const collections = order.payment_collections || [];
  if (collections.length > 0) {
    nativePaid = collections.reduce(
      (sum, pc) =>
        sum + (asNum(pc?.captured_amount) - asNum(pc?.refunded_amount)),
      0
    );
  }
  const ps = asString(order.payment_status);
  if (nativePaid == null && ps === "captured")
    nativePaid = getOrderTotal(order);
  if (nativePaid == null && (ps === "not_paid" || ps === "refunded")) {
    nativePaid = 0;
  }
  return nativePaid;
}

function getSettledAmount(order: OrderForMeili): number {
  return (getPaidAmount(order) ?? 0) + getDepositAmount(order);
}

function getEffectivePaymentStatus(
  order: OrderForMeili
): EffectivePaymentStatus {
  const meta = (order.metadata || {}) as Record<string, unknown>;
  if (meta.qb_sync_status === "voided") return "voided";

  // Settled, not paid: a deposit that covers the order settles it even before
  // an invoice consumes it. Paid Amt alone would report a fully-funded order as
  // owing money for as long as it stayed uninvoiced.
  const settled = getSettledAmount(order);
  const total = getOrderTotal(order) ?? 0;

  // A CENT, not "greater than zero". #1487 carried current_order_total =
  // 0.0024 — positive in dollars, zero once rounded to cents — so a $6.39
  // remainder read as covering it and the order came out fully_paid with
  // total_cents = 0, a combination that looks impossible until you find the
  // sub-cent. order_money_projection stores cents, so classifying on
  // unrounded dollars made the projection and this doc disagree. Money below
  // a cent is not money; both sides now agree on that.
  if (settled > 0 && total >= 0.01 && settled + 0.01 >= total) {
    return "fully_paid";
  }
  if (settled > 0) return "deposited";
  // A zero-total order (warranty replacement) owes nothing — "Not Paid" would
  // demand money that was never due. Ordered AFTER the settled>0 branches so a
  // sub-cent order holding a live deposit (#1487) still reads deposited.
  // Mirror of getEffectivePaymentStatus in store-pos/app/(pos)/orders/utils.ts.
  if (total < 0.01) return "fully_paid";
  return "not_paid";
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

  // Prefer the native field if it actually came through (e.g. when the doc
  // is built from /admin/orders REST output). Fall back to the local compute
  // when query.graph delivered nothing — that's the path used by both the
  // backfill script and the subscriber, where the field arrives empty.
  const nativeStatus = asString(order.fulfillment_status);
  const fulfillmentStatus =
    nativeStatus || computeFulfillmentStatus(order.fulfillments, order.items);

  // Match the POS UI helpers exactly (orders/utils.ts):
  //   isCanceled = status==='canceled' || fulfillment_status==='canceled'
  //   isVoided   = metadata.qb_sync_status === 'voided'
  const isCanceled =
    asString(order.status) === "canceled" || fulfillmentStatus === "canceled";
  const isVoided = meta.qb_sync_status === "voided";

  // A "web order" is anything NOT from the POS sales channel and not flagged
  // pos_created. Mirrors the frontend isWebOrder() helper.
  const salesChannelId = asString(order.sales_channel?.id);
  const isWeb = salesChannelId !== POS_SC_ID && meta.pos_created !== true;
  // Legacy field kept for backwards compatibility (channel-only check).
  const isWebOrder = salesChannelId !== POS_SC_ID;

  const effectivePayment = getEffectivePaymentStatus(order);
  // "Unpaid" means money is still owed, not that nothing has arrived (changed
  // 2026-07-29 by the operator's call). An order with a deposit that does not
  // cover the total belongs in the same work queue as one with nothing paid:
  // in both cases someone still has to collect. An order whose deposit covers
  // it in full does not, which is what keeps this from swallowing the whole
  // list. A voided order is excluded — it is cancelled, not owing.
  //
  // Mirror of isUnpaid() in store-pos/app/(pos)/orders/utils.ts. These two MUST
  // agree: this flag decides the Unpaid tab's membership server-side while that
  // one labels the rows, and a tab whose rows disagree with it is the bug this
  // codebase keeps re-learning.
  // Settled, not paid: the deposit still sitting on the order counts toward
  // covering it. Otherwise a funded-but-uninvoiced order reads as owing.
  const paidForBalance = getSettledAmount(order);
  const totalForBalance = getOrderTotal(order) ?? 0;
  const owesMoney =
    effectivePayment !== "voided" &&
    // A cent, matching getEffectivePaymentStatus and the cents the projection
    // stores. See the sub-cent note there.
    totalForBalance >= 0.01 &&
    paidForBalance + 0.01 < totalForBalance;
  const isDraft = isDraftOrder(order);
  // A natively-completed order is DONE regardless of its (sometimes stale /
  // race-prone) fulfillment_status. Without this, a completed order whose
  // fulfillment_status computed to "partially_delivered" stuck in the Open tab
  // forever (e.g. S10374). order.status='completed' is the authoritative
  // "this order is closed" signal, so it must force is_closed / clear is_open.
  const isCompleted = asString(order.status) === "completed";
  // Archived = terminal state of a POS close on a partially-invoiced order
  // (toggle-close complete→archive chain). Closed regardless of fulfillment.
  const isArchived = asString(order.status) === "archived";
  // Legacy POS-level close (pre-archived rows): order.status='pending' with
  // only metadata.pos_closed marking it. Without honoring the flag here such
  // an order reads is_open forever (e.g. S10885). Reopen clears the flag.
  const isPosClosed = meta.pos_closed === true;
  const isClosed =
    isCompleted ||
    isArchived ||
    isPosClosed ||
    CLOSED_FULFILLMENT.has(fulfillmentStatus);
  const isOpen = !isClosed && OPEN_FULFILLMENT.has(fulfillmentStatus);
  // A separated (layaway) order leaves the Separated view once it is no longer
  // an open order: either fulfilled/shipped/delivered OR fully invoiced (every
  // remaining line billed — also covers an order edited down until nothing is
  // left to dispatch). meta.fully_invoiced is maintained by the order Meili
  // sync subscriber on invoice + order-edit events.
  const isSeparated =
    !!meta.is_separated && !isClosed && meta.fully_invoiced !== true;
  // Same gate, three states. metadata.separation_status is written by the
  // separations and product-status routes; orders that predate per-line
  // tracking carry only the boolean, which deriveSeparationStatus honors as
  // "full" — mirrored here so a legacy order keeps the tab membership it had.
  const rawSeparation = asString(meta.separation_status);
  const separationState: "none" | "partial" | "full" =
    isClosed || meta.fully_invoiced === true
      ? "none"
      : rawSeparation === "partial" || rawSeparation === "full"
        ? rawSeparation
        : meta.is_separated
          ? "full"
          : "none";

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
    fulfillment_status: fulfillmentStatus,
    effective_payment: effectivePayment,
    has_deposit: getDepositAmount(order) >= 0.01,
    is_unpaid: owesMoney,
    is_draft: isDraft,
    is_open: isOpen,
    is_closed: isClosed,
    is_separated: isSeparated,
    separation_state: separationState,
    is_canceled: isCanceled,
    is_voided: isVoided,
    is_web: isWeb,
    is_web_order: isWebOrder,
    sales_rep_initials: salesRepInitials,
    sales_channel_id: salesChannelId,
    // Same resolved total the payment logic uses, not the raw `order.total`.
    // query.graph never delivers that field, so this was 0 on every document in
    // the index — and total_cents is a sortableAttribute, meaning a Meili-side
    // sort by order value was sorting a column of zeroes.
    total_cents: Math.round((getOrderTotal(order) ?? 0) * 100),
    created_at_ts: ts(order.created_at),
    effective_date_ts:
      ts((meta.order_placed_at as string | Date | null | undefined) ?? null) ||
      ts(order.created_at),
    updated_at_ts: ts(order.updated_at),
  };
}
