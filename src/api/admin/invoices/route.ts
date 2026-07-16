/**
 * src/api/admin/invoices/route.ts
 * GET  /admin/invoices       — List invoices (filter by order_id)
 * POST /admin/invoices       — Create a new invoice
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

// Import the background syncing handlers directly to bypass Medusa outbox dropping events
// 1.5.7: handleFulfillmentCreated import removed — invoices route enqueues now.
import { handlePosPaymentApplied } from "../../../lib/quickbooks/handlers/handle-pos-payment-applied";
import { handlePosPaymentCreated } from "../../../lib/quickbooks/handlers/handle-pos-payment-created";
// 1.5.6: handleSalesReceiptCreated import removed — invoices route enqueues now.
import {
  writePipelineRow,
  skipSalesOrderPipelineRow,
  skipPendingPaymentRows,
} from "../../../lib/quickbooks/qb-pipeline";
import { getVariantAvgCostBatch } from "../../../lib/cost/get-variant-avg-cost";
import { getDbPool } from "../../utils/db-pool";
import { sortDocItemsByInsertion } from "./_lib/item-order";
import { maybeCompleteOrder } from "../../../lib/maybe-complete-order";
import {
  allocateNextNumber,
  buildInvoiceRequestHash,
  claimInvoiceCreate,
  finalizeInvoiceCreate,
  resolveInvoiceDedupKey,
  type TxManager,
} from "../../../lib/invoices/document-numbering";
import { FINANCE_MODULE } from "../../../modules/finance";
import { INVOICE_MODULE } from "../../../modules/invoices";

import { reconcileOrderReservations } from "../../../lib/finance/reconcile-order-reservations";
import { getFiniteMoney, getNum } from "./payment-balance";
import { registerMedusaPayment } from "./register-medusa-payment";
// ── GET /admin/invoices?order_id=:id ─────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);
  const { order_id, customer_id, created_at, status, limit, offset, balance_due_gt, delivery_active } =
    req.query as Record<string, any>;

  const filters: Record<string, unknown> = {};
  if (order_id) filters.order_id = order_id;
  if (customer_id) filters.customer_id = customer_id;
  if (created_at) filters.created_at = created_at;
  if (status) filters.status = status;
  if (balance_due_gt !== undefined) filters.balance_due = { $gt: parseInt(balance_due_gt, 10) };

  // [Deliveries] tab: invoices with a shipment in flight (order_delivery not
  // yet delivered/canceled). Reads live rows — no Meili plumbing; delivered
  // shipments drop off the tab the moment the 6h poll (or a webhook) lands.
  let deliveryByInvoice: Record<string, unknown> | undefined;
  if (delivery_active !== undefined) {
    // Latest live delivery per invoice — DELIVERED rows stay in the map (the
    // Fulfillment badge is tracking-status-driven) but only ACTIVE ones keep
    // the invoice inside the tab.
    const { rows } = await getDbPool().query(
      `SELECT DISTINCT ON (invoice_id)
              invoice_id, status, status_detail, tracking_number, tracking_url,
              carrier, service, shipped_at, delivered_at, status_checked_at
         FROM order_delivery
        WHERE deleted_at IS NULL AND voided_at IS NULL
          AND invoice_id IS NOT NULL
          AND status <> 'canceled'
        ORDER BY invoice_id, created_at DESC`
    );
    deliveryByInvoice = Object.fromEntries(
      rows.map((r: { invoice_id: string }) => [r.invoice_id, r])
    );
    const activeIds = rows
      .filter((r: { status: string }) => r.status !== "delivered")
      .map((r: { invoice_id: string }) => r.invoice_id);
    if (activeIds.length === 0) {
      return res.json({ invoices: [], delivery_by_invoice: deliveryByInvoice });
    }
    filters.id = activeIds;
  }

  const config: Record<string, any> = {
    relations: ["items", "tracking_links"],
    order: { created_at: "DESC" },
    take: limit ? parseInt(limit, 10) : 200,
  };
  if (offset) config.skip = parseInt(offset, 10);

  const invoices = await invoiceService.listPosInvoices(filters, config);

  // Enrich with customer data in a single batch query
  const customerIds = [
    ...new Set(invoices.map((i: any) => i.customer_id).filter(Boolean)),
  ];
  const customers = customerIds.length
    ? await customerModule.listCustomers(
        { id: customerIds },
        {
          select: [
            "id",
            "first_name",
            "last_name",
            "email",
            "phone",
            "company_name",
          ],
        }
      )
    : [];
  const customerMap = Object.fromEntries(customers.map((c: any) => [c.id, c]));

  const enriched = invoices.map((inv: any) => ({
    ...inv,
    // The `items` hasMany has no default ORDER BY → restore insertion (ULID id)
    // order so comment/header lines stay where the operator placed them.
    items: sortDocItemsByInsertion(inv.items),
    customer: customerMap[inv.customer_id] ?? null,
  }));

  return res.json(
    deliveryByInvoice
      ? { invoices: enriched, delivery_by_invoice: deliveryByInvoice }
      : { invoices: enriched }
  );
}

// ── POST /admin/invoices ──────────────────────────────────────────────────────

interface CreateInvoiceBody {
  order_id: string;
  order_display_id: number;
  fulfillment_id?: string;
  customer_id: string;
  items: Array<{
    variant_id?: string;
    sku?: string;
    description: string;
    quantity: number;
    unit_price: number; // cents
    total: number; // cents (GROSS line: unit_price × qty)
    net_total?: number; // cents — frozen post-line-discount, pre-order-discount net (round-then-multiply)
    attached_image?: string | null; // base64 JPEG (96x96 @ 0.6) — snapshotted from order line item
    discount_type?: "percent" | "fixed" | null;
    discount_value?: number | null;
  }>;
  subtotal: number; // cents
  discount?: number; // cents
  shipping: number; // cents
  tax: number; // cents
  total: number; // cents
  amount_paid: number; // cents
  /**
   * Payment method at issuance. Optional/null when the invoice is created with
   * Skip Payment (amount_paid === 0). The field is populated on the first
   * payment captured via POST /invoices/[id]/payments.
   */
  payment_method?:
    | "credit_card"
    | "debit_card"
    | "cash"
    | "check"
    | "ach"
    | "zelle"
    | "credit" // Store credit / credit memo — legacy meaning preserved.
    | "mixed"
    // Legacy values — accepted for inbound requests but normalized before persist.
    | "card"
    | "visa"
    | "mastercard"
    | "amex"
    | "discover"
    | "capital_one"
    | "credit_memo"
    | null;
  /**
   * Card network when payment_method is a card. Optional — null for cash/check/zelle/ach
   * or for debit-only transactions where the brand is intentionally not recorded.
   */
  card_brand?:
    | "visa"
    | "mastercard"
    | "amex"
    | "discover"
    | "capital_one"
    | null;
  notes?: string;
  created_by?: string;
  shipping_address?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    province?: string;
    postal_code?: string;
    country_code?: string;
    phone?: string;
  };
  order_document_number?: string;
  send_email?: boolean;
  email_to?: string;
  email_cc?: string;
  is_sales_receipt?: boolean;
  /** If set, a CustomerPayment was already created by the terminal route — skip creating a new one and link this ID instead */
  terminal_payment_id?: string;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const body = req.body as CreateInvoiceBody;

  if (!body.order_id || !body.customer_id || !body.items?.length) {
    return res
      .status(400)
      .json({ error: "order_id, customer_id, and items are required" });
  }

  // Codex audit finding #5: amount_paid feeds balance_due (derivedTotal -
  // amount_paid), initialStatus, and every downstream payment/application
  // write with no floor — a negative value would inflate balance_due and
  // silently skip Step 3's payment recording (`if (body.amount_paid > 0)`).
  // Round 2: NaN/Infinity satisfy `typeof === "number"` and are not `< 0`,
  // so they slipped through — require a finite number.
  if (
    typeof body.amount_paid !== "number" ||
    !Number.isFinite(body.amount_paid) ||
    body.amount_paid < 0
  ) {
    return res
      .status(400)
      .json({ error: "amount_paid must be a non-negative finite number" });
  }

  // Round 2: a terminal payment ALWAYS charged a positive amount (the terminal
  // route rejects amountCents <= 0), so amount_paid=0 alongside a
  // terminal_payment_id is a stale client value (React state race on the POS
  // auto-submit). Letting it through would claim the `terminal:<id>` dedup key
  // on a $0 invoice — Step 3 records no application, and the correct retry
  // then bounces off claimInvoiceCreate ("existing") forever. Reject BEFORE
  // any dedup/number work.
  if (body.terminal_payment_id && !(body.amount_paid > 0)) {
    return res.status(400).json({
      error:
        "amount_paid must be > 0 when terminal_payment_id is provided (a terminal payment always captured a positive amount)",
      code: "TERMINAL_PAYMENT_ZERO_AMOUNT",
    });
  }

  // ── Idempotency: a terminal_payment_id can only be applied to ONE invoice ──
  // The terminal route already created a CustomerPayment when the card was
  // charged. If the client retries this POST (browser double-click, network
  // retry, recovery button), we must NOT create a second invoice — it would
  // consume two sequence numbers and leave an orphan Sales Receipt in QB.
  // Runs BEFORE nextval() so we don't burn invoice/SR sequence numbers on retries.
  let idempotencyPrecheckFailed = false;
  if (body.terminal_payment_id) {
    try {
      const existingApplications = await financeService.listPaymentApplications(
        {
          payment_id: body.terminal_payment_id,
        }
      );
      // Only an INVOICE-BOUND application means "this terminal payment already
      // has its invoice" — an order-only application (invoice_id=NULL) is just
      // the checkout-time auto-link reservation (see store-pos bams/terminal
      // route) and must NOT short-circuit invoice creation, or every terminal
      // checkout would incorrectly bounce back a nonexistent prior invoice.
      const invoiceBoundApplication = existingApplications.find(
        (a: any) => !a.voided_at && a.invoice_id != null
      );
      if (invoiceBoundApplication) {
        const existingInvoiceId = (invoiceBoundApplication as any).invoice_id;
        const existingInvoice =
          await invoiceService.retrievePosInvoice(existingInvoiceId);
        console.warn(
          `[invoice] Idempotent short-circuit: terminal_payment ${body.terminal_payment_id} ` +
            `already applied to invoice ${existingInvoiceId}. Returning existing.`
        );
        return res.status(200).json({
          invoice: existingInvoice,
          idempotent: true,
        });
      }
    } catch (idemErr: any) {
      // Round 2: do NOT fall through blindly — under a transient read failure
      // we cannot know whether this terminal payment already has its invoice.
      // Flag it; the mandatory retrieveCustomerPayment below (which loads the
      // same applications relation) re-runs the short-circuit. Only if BOTH
      // reads fail does the request get rejected (503) — never create an
      // invoice under uncertainty.
      idempotencyPrecheckFailed = true;
      console.warn(
        `[invoice] Idempotency check failed for terminal_payment ${body.terminal_payment_id}: ${idemErr.message} — will re-verify via mandatory payment retrieve`
      );
    }
  }

  // ── Path B detection (auto-downgrade Sales Receipt → Invoice) ─────────────
  // If the order already has a QB Sales Order or Estimate, OR the order is
  // more than 1 hour old, we cannot create a Sales Receipt — QB Desktop requires
  // an Invoice linked to the existing SO/Estimate. Silently downgrade to keep
  // the POS flow frictionless; accounting reviews documents downstream.
  //
  // pathBAudit collects inputs/outputs of the SR vs Invoice decision. Persisted
  // to qb_invoice_path_audit for 24h to debug spurious downgrades. Populated
  // regardless of whether body.is_sales_receipt was true at entry.
  const bodyIsSalesReceiptAtEntry = !!body.is_sales_receipt;
  const pathBAudit: {
    has_existing_qb_doc: boolean | null;
    has_existing_qb_doc_keys: Record<string, unknown> | null;
    age_ms: number | null;
    has_pending_so_in_pipeline: boolean | null;
    path_b_triggered: boolean;
    order_metadata_snapshot: any;
  } = {
    has_existing_qb_doc: null,
    has_existing_qb_doc_keys: null,
    age_ms: null,
    has_pending_so_in_pipeline: null,
    path_b_triggered: false,
    order_metadata_snapshot: null,
  };
  try {
    const orderModule = req.scope.resolve(Modules.ORDER);
    const order = (await orderModule.retrieveOrder(body.order_id, {
      select: ["id", "created_at", "metadata"],
    })) as any;
    const meta = order?.metadata ?? {};
    pathBAudit.order_metadata_snapshot = meta;
    const docKeys = {
      qb_sales_order_txn_id: meta.qb_sales_order_txn_id ?? null,
      qb_estimate_txn_id: meta.qb_estimate_txn_id ?? null,
      "qb_sales_order.txn_id": meta.qb_sales_order?.txn_id ?? null,
      "qb_estimate.txn_id": meta.qb_estimate?.txn_id ?? null,
    };
    pathBAudit.has_existing_qb_doc_keys = docKeys;
    const hasExistingQbDoc = Boolean(
      docKeys.qb_sales_order_txn_id ||
        docKeys.qb_estimate_txn_id ||
        docKeys["qb_sales_order.txn_id"] ||
        docKeys["qb_estimate.txn_id"]
    );
    pathBAudit.has_existing_qb_doc = hasExistingQbDoc;
    const createdAt = order?.created_at
      ? new Date(order.created_at).getTime()
      : Date.now();
    const ageMs = Date.now() - createdAt;
    pathBAudit.age_ms = ageMs;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    // Also check the pipeline table — SO may have already been submitted to the QB bridge.
    // Only downgrade if the SO crossed the submission boundary (status=submitted/confirmed).
    // A 'pending' or 'waiting' SO row hasn't reached QB yet and will be safely skipped
    // by skipSalesOrderPipelineRow() below — do NOT let it force an Invoice path.
    let hasPendingSoInPipeline = false;
    try {
      const pbPool = req.scope.resolve("__pg_connection__") as any;
      const pbCheck = await pbPool.raw(
        `SELECT id FROM qb_order_pipeline WHERE order_id = ? AND step = 'sales_order' AND status IN ('submitted','confirmed') LIMIT 1`,
        [body.order_id]
      );
      hasPendingSoInPipeline = (pbCheck.rows?.length ?? 0) > 0;
    } catch {
      /* best-effort */
    }
    pathBAudit.has_pending_so_in_pipeline = hasPendingSoInPipeline;
    if (
      body.is_sales_receipt &&
      (hasExistingQbDoc || ageMs > ONE_HOUR_MS || hasPendingSoInPipeline)
    ) {
      pathBAudit.path_b_triggered = true;
      console.warn(
        `[invoice] Path B detected for order ${body.order_id} — ` +
          `downgrading is_sales_receipt=true → false. ` +
          `hasExistingQbDoc=${hasExistingQbDoc}, ageMs=${ageMs}, hasPendingSO=${hasPendingSoInPipeline}`
      );
      body.is_sales_receipt = false;
    }
  } catch (pbErr: any) {
    console.warn(
      `[invoice] Path B detection failed for order ${body.order_id}: ${pbErr.message}`
    );
  }

  // pgConnection is used for many raw reads/writes later in this route.
  const pgConnection = req.scope.resolve("__pg_connection__") as any;

  // Gapless document numbers are allocated TRANSACTIONALLY in Step 1 below
  // (lib/invoices/document-numbering) — never via nextval(), which burns a
  // number on rollback. invoice_number is referenced throughout the route; the
  // QB ref number lives only inside the create transaction.
  let invoice_number = "";

  // Net (post-line-discount, pre-order-discount) cents for a line. Prefer what the
  // POS sent; if absent (older POS build / non-POS caller) recompute with the same
  // round-then-multiply convention from gross + descriptor. NEVER fall back to gross —
  // that would strip the discount when the line is synced to QuickBooks.
  const resolveNetTotalCents = (it: CreateInvoiceBody["items"][number]): number => {
    if (it.net_total != null) return Math.round(it.net_total);
    const grossCents = Math.round(it.total || 0);
    const qty = Number(it.quantity || 0);
    const value = Number(it.discount_value ?? 0);
    if (!it.discount_type || !(value > 0) || qty <= 0) return grossCents;
    if (it.discount_type === "percent") {
      const unitCents = Math.round(grossCents / qty);
      const discUnit = Math.max(0, Math.round((unitCents * (100 - value)) / 100));
      return discUnit * qty;
    }
    // fixed: a flat amount off each unit
    return Math.max(0, grossCents - Math.min(grossCents, Math.round(value * 100) * qty));
  };

  // Derive the header summary FROM the (immutable) line items so it can never drift from
  // the printed/QB-synced detail. `discount` is the COMBINED discount (per-line + order-level)
  // — the convention the QB sync handler and every historical invoice rely on (it strips the
  // per-line portion to recover the order-level promotion). Therefore:
  //     subtotal = Σ(line GROSS) − combined discount   (=== Σ net − order-level)
  // and the invariant subtotal + discount === Σ(line gross) holds by construction.
  // Lines-derived numbers are authoritative; body.* is the fallback only when no items are
  // present (rare non-POS callers).
  const hasItems = !!body.items?.length;
  const grossSumCents = hasItems
    ? body.items.reduce((sum, it) => sum + Math.round(it.total || 0), 0)
    : body.subtotal + (body.discount ?? 0);
  const netSumCents = hasItems
    ? body.items.reduce((sum, it) => sum + resolveNetTotalCents(it), 0)
    : body.subtotal;
  const combinedDiscountCents = body.discount ?? 0;
  // Guard: a combined discount can never be smaller than the per-line portion it must contain.
  const perLineDiscountCents = Math.max(0, grossSumCents - netSumCents);
  const safeDiscountCents = Math.max(combinedDiscountCents, perLineDiscountCents);
  const derivedSubtotal = Math.max(0, grossSumCents - safeDiscountCents);
  const derivedTotal = derivedSubtotal + (body.shipping ?? 0) + body.tax;
  const derivedUntaxed = derivedSubtotal + (body.shipping ?? 0);
  if (hasItems && Math.abs(derivedTotal - body.total) > 1) {
    console.warn(
      `[invoice] header/items total divergence corrected: client sent total=${body.total} subtotal=${body.subtotal} discount=${combinedDiscountCents}, derived total=${derivedTotal} subtotal=${derivedSubtotal} (gross=${grossSumCents} net=${netSumCents}). Using items-derived values.`
    );
  }

  const balance_due = derivedTotal - body.amount_paid;

  // Normalize payment_method + card_brand into the canonical split format.
  //   New callers send:  payment_method='credit_card'|'debit_card'|'cash'|... card_brand=<brand>|null
  //   Legacy callers send the brand directly as payment_method ('visa', 'mastercard',
  //   etc.) with no card_brand. We translate those here so persistence is always
  //   in the new format.
  //
  //   Special cases:
  //   - 'debit_card' is already canonical → pass through, card_brand stays as caller sent
  //   - 'credit' = store credit (legacy meaning preserved — NOT a credit card)
  //   - 'credit_memo' = store credit consumption (alias for 'credit' in some old flows)
  const CARD_BRANDS = new Set([
    "visa",
    "mastercard",
    "amex",
    "discover",
    "capital_one",
  ]);
  let normalizedPaymentMethod: string | null = body.payment_method ?? null;
  let normalizedCardBrand: string | null = body.card_brand ?? null;
  if (normalizedPaymentMethod && CARD_BRANDS.has(normalizedPaymentMethod)) {
    normalizedCardBrand = normalizedPaymentMethod;
    normalizedPaymentMethod = "credit_card";
  }

  let paymentIdToEmit: string | null = null;
  let nextPayNum: number | null = null;
  const applicationsToEmit: any[] = [];
  // The QB Sales Receipt needs the exact card type (e.g. 'mastercard') to pick the
  // correct Payment Method in QuickBooks. body.payment_method can be stale ('card',
  // 'cash' default, etc.) when the Dejavoo terminal fires the auto-submit. For
  // terminal-sourced payments we override this with the card type that Dejavoo
  // actually reported, stored on the customer_payment metadata.
  let resolvedPaymentMethod: string | null = normalizedPaymentMethod;
  let resolvedCardBrand: string | null = normalizedCardBrand;

  // Pre-create override: for terminal-sourced payments, the Dejavoo terminal
  // stores the actual detected payment method + card brand on the
  // customer_payment.metadata. body.payment_method can be stale (e.g. body
  // arrives as 'credit_card' when the swipe was actually debit, or 'cash'
  // default) because the POS auto-submit fires before React setState
  // finishes propagating the update. We MUST read the terminal's
  // source-of-truth BEFORE createPosInvoices so every downstream consumer
  // (including the QB Sales Receipt / ReceivePayment handlers that read from
  // pos_invoice.payment_method + pos_invoice.card_brand) sees the correct
  // values. Keep this retrieve hoisted so the terminal sub-branch below can
  // reuse termPay for tagging without a second DB round-trip.
  let termPay: any = null;
  if (body.terminal_payment_id) {
    // Round 2 (MANDATORY, fail-fast): this retrieve used to be best-effort —
    // a transient read failure left termPay=null, which (a) skipped the
    // over-claim guard below (fail-open), (b) bypassed Step 3's
    // CONVERT-ON-APPLY lookup so the order-only reservation survived NEXT TO a
    // fresh invoice-bound application (the exact Treasury double-count this
    // whole fix exists to prevent), and (c) forced the status calc's
    // `?? body.amount_paid` fallback to mark the payment fully "applied".
    // A terminal invoice must never be created without a verified payment.
    try {
      termPay = await financeService.retrieveCustomerPayment(
        body.terminal_payment_id,
        { relations: ["applications"] }
      );
    } catch (tpErr: any) {
      const isNotFound =
        tpErr?.type === "not_found" || /not found/i.test(tpErr?.message ?? "");
      console.error(
        `[invoice] Mandatory terminal payment read failed for ${body.terminal_payment_id} (${isNotFound ? "not found" : "read error"}): ${tpErr.message}`
      );
      return res.status(isNotFound ? 404 : 503).json({
        error: isNotFound
          ? `terminal_payment_id ${body.terminal_payment_id} not found`
          : `Could not verify terminal payment ${body.terminal_payment_id} — please retry`,
        code: isNotFound
          ? "TERMINAL_PAYMENT_NOT_FOUND"
          : "TERMINAL_PAYMENT_READ_FAILED",
      });
    }
    if (!termPay) {
      return res.status(404).json({
        error: `terminal_payment_id ${body.terminal_payment_id} not found`,
        code: "TERMINAL_PAYMENT_NOT_FOUND",
      });
    }

    // If the cheap idempotency precheck above failed transiently, re-run the
    // same invoice-bound short-circuit on the applications we just loaded —
    // never create a second invoice under uncertainty.
    if (idempotencyPrecheckFailed) {
      const invoiceBoundApp = (termPay.applications ?? []).find(
        (a: any) => !a.voided_at && a.invoice_id != null
      );
      if (invoiceBoundApp) {
        const existingInvoice = await invoiceService.retrievePosInvoice(
          invoiceBoundApp.invoice_id
        );
        console.warn(
          `[invoice] Idempotent short-circuit (recovered via mandatory retrieve): terminal_payment ${body.terminal_payment_id} already applied to invoice ${invoiceBoundApp.invoice_id}. Returning existing.`
        );
        return res.status(200).json({
          invoice: existingInvoice,
          idempotent: true,
        });
      }
    }

    const termPosMethod = termPay?.metadata?.pos_payment_method as
      | string
      | undefined;
    const termCardBrand =
      (termPay?.metadata?.card_brand as string | undefined) ?? null;
    if (termPosMethod && termPosMethod !== normalizedPaymentMethod) {
      console.log(
        `[invoice] Overriding payment_method '${normalizedPaymentMethod}' → '${termPosMethod}' from terminal_payment metadata (source of truth)`
      );
      resolvedPaymentMethod = termPosMethod;
      resolvedCardBrand = termCardBrand;
    } else if (termCardBrand && !resolvedCardBrand) {
      // Method already matches but terminal payment has a brand we don't — adopt it.
      resolvedCardBrand = termCardBrand;
    }
  }

  // How much of termPay is still un-invoice-bound (order-only reservations are
  // convertible, so only prior INVOICE-BOUND applications count as spent —
  // mirrors finance/payments/[id]/apply/route.ts's invoiceBoundApplied). Hoisted
  // here (computed once from the termPay.applications already loaded above) so
  // both the guard below and the Step 3 CONVERT-ON-APPLY status calc reuse the
  // same number instead of drifting.
  const termPayInvoiceBoundApplied = (termPay?.applications ?? [])
    .filter((a: any) => !a.voided_at && a.invoice_id != null)
    .reduce((sum: number, a: any) => sum + getNum(a.amount_applied), 0);

  // Codex audit finding #4: unlike finance/payments/[id]/apply/route.ts, this
  // branch never clamped body.amount_paid against what termPay actually has
  // left to give — a caller/recovery-path bug sending too large an
  // amount_paid would let the CONVERT-ON-APPLY block (Step 3) mint a
  // payment_application worth more than the CustomerPayment itself, breaking
  // SUM(payment_application.amount_applied) <= customer_payment.amount. Fail
  // closed here, before allocating a number / opening the tx, rather than
  // silently truncating the invoice's own amount_paid.
  if (termPay && body.terminal_payment_id) {
    // Round 2: money fields are model.bigNumber() and can surface as
    // number/string/BigNumber-shaped objects. Number({...}) is NaN, and
    // `body.amount_paid > NaN` is FALSE — the guard would silently fail open.
    // getFiniteMoney fails CLOSED: unreadable amount → reject, never let an
    // unverifiable payment mint applications.
    const termPayAmount = getFiniteMoney(termPay.amount);
    if (termPayAmount === null) {
      console.error(
        `[invoice] terminal payment ${body.terminal_payment_id} has unreadable amount: ${JSON.stringify(termPay.amount)}`
      );
      return res.status(500).json({
        error: `Terminal payment ${body.terminal_payment_id} amount could not be read — refusing to create invoice.`,
        code: "TERMINAL_PAYMENT_AMOUNT_UNREADABLE",
      });
    }
    const termPayAvailable = termPayAmount - termPayInvoiceBoundApplied;
    if (
      !Number.isFinite(termPayAvailable) ||
      body.amount_paid > termPayAvailable
    ) {
      return res.status(400).json({
        error: `amount_paid (${body.amount_paid}) exceeds what terminal_payment_id ${body.terminal_payment_id} has available to apply (${termPayAvailable}).`,
      });
    }
  }

  // Validate BEFORE allocating a number / opening the tx (Codex review): a 400
  // must never strand a burned number or a committed half-invoice.
  if (body.amount_paid > 0 && !resolvedPaymentMethod) {
    return res.status(400).json({
      error:
        "payment_method is required when amount_paid > 0 (skip-payment invoices must send amount_paid: 0)",
    });
  }

  const initialStatus =
    balance_due <= 0 ? "paid" : body.amount_paid > 0 ? "partial" : "issued";

  // Snapshot avg unit cost (read) BEFORE the tx so the counter lock is held
  // only for the inserts. Custom lines without variant_id legitimately get NULL.
  const itemVariantIds = (body.items ?? [])
    .map((it) => it.variant_id)
    .filter((id): id is string => !!id);
  const costMap = await getVariantAvgCostBatch(req.scope, itemVariantIds);

  // Dedup identity — built AFTER Path B may have flipped is_sales_receipt.
  const requestHash = buildInvoiceRequestHash({
    order_id: body.order_id,
    customer_id: body.customer_id,
    fulfillment_id: body.fulfillment_id ?? null,
    is_sales_receipt: !!body.is_sales_receipt,
    amount_paid: body.amount_paid,
    total: derivedTotal,
    payment_method: resolvedPaymentMethod ?? null,
    items: body.items ?? [],
  });
  const dedupKey = resolveInvoiceDedupKey({
    idempotencyKeyHeader: (req.headers["idempotency-key"] as string) ?? null,
    terminalPaymentId: body.terminal_payment_id ?? null,
    requestHash,
  });

  type CoreResult =
    | { kind: "created"; invoice: any }
    | { kind: "existing"; invoiceId: string }
    | { kind: "conflict" }
    | { kind: "in_progress" };

  // ── Step 1: transactional, gapless, idempotent invoice + items create ─────
  // ONE physical transaction: claim dedup → allocate the 2 counters this doc
  // needs → insert header + items → finalize claim. A rollback advances no
  // counter (no gaps, no collision) and leaves no orphan. All cross-module side
  // effects (payments, finance, QB, events, reservation release) stay BELOW,
  // after commit, and remain idempotent.
  const core: CoreResult = await invoiceService.withTransaction(async (ctx) => {
    const em = ctx.transactionManager as unknown as TxManager;

    const claim = await claimInvoiceCreate(em, dedupKey, requestHash);
    if (claim.status === "existing")
      return { kind: "existing", invoiceId: claim.invoiceId };
    if (claim.status === "conflict") return { kind: "conflict" };
    if (claim.status === "in_progress") return { kind: "in_progress" };

    // claimed → allocate exactly the two counters this document class needs.
    invoice_number = String(await allocateNextNumber(em, "medusa_invoice"));
    const qb_metadata_ref_number = String(
      await allocateNextNumber(
        em,
        body.is_sales_receipt ? "qb_sales_receipt" : "qb_invoice"
      )
    );

    const created = await invoiceService.createPosInvoices(
      {
        invoice_number,
        order_id: body.order_id,
        fulfillment_id: body.fulfillment_id ?? null,
        customer_id: body.customer_id,
        status: initialStatus as "issued" | "paid" | "partial",
        subtotal: derivedSubtotal,
        discount: safeDiscountCents,
        shipping: body.shipping ?? 0,
        tax: body.tax,
        untaxed_total: derivedUntaxed,
        total: derivedTotal,
        amount_paid: body.amount_paid,
        balance_due,
        payment_method: resolvedPaymentMethod as any,
        card_brand: resolvedCardBrand,
        issued_at: new Date(),
        paid_at: balance_due <= 0 ? new Date() : null,
        notes: body.notes ?? null,
        created_by: body.created_by ?? null,
        shipping_address: body.shipping_address ?? null,
        metadata: {
          is_sales_receipt: !!body.is_sales_receipt,
          qb_ref_number: qb_metadata_ref_number,
        },
      },
      ctx
    );

    if (body.items?.length) {
      await invoiceService.createPosInvoiceItems(
        body.items.map((it) => {
          const cost = it.variant_id ? costMap.get(it.variant_id) : undefined;
          return {
            invoice_id: (created as any).id,
            variant_id: it.variant_id ?? null,
            sku: it.sku ?? null,
            description: it.description,
            quantity: it.quantity,
            unit_price: it.unit_price,
            total: it.total,
            // Frozen net (round-then-multiply), always populated for new
            // invoices so the QB sync's NULL-guard only fires for legacy rows.
            net_total_cents: resolveNetTotalCents(it),
            attached_image: it.attached_image ?? null,
            average_unit_cost: cost?.cost ?? null,
            average_unit_cost_synced_at: cost?.synced_at ?? null,
            discount_type: it.discount_type ?? null,
            discount_value: it.discount_value ?? null,
          };
        }),
        ctx
      );
    }

    await finalizeInvoiceCreate(em, dedupKey, requestHash, (created as any).id);
    return { kind: "created", invoice: created };
  });

  // Resolve dedup outcomes OUTSIDE the transaction callback (never return res
  // from inside it).
  if (core.kind === "existing") {
    const existing = await invoiceService.retrievePosInvoice(core.invoiceId);
    return res.status(200).json({ invoice: existing, idempotent: true });
  }
  if (core.kind === "conflict") {
    return res.status(409).json({
      code: "INVOICE_DEDUP_CONFLICT",
      error:
        "An invoice with this Idempotency-Key already exists for a different request.",
    });
  }
  if (core.kind === "in_progress") {
    return res.status(409).json({
      code: "INVOICE_CREATE_IN_PROGRESS",
      error: "A matching invoice create is still in progress. Please retry.",
    });
  }

  const invoice = core.invoice;

  // Step 2B (REMOVED 2026-07-10): invoicing no longer releases reservations.
  // Sold-but-undelivered goods stay reserved ("apartado") until the REAL
  // fulfillment consumes them: immediate pickup (create-fulfillment-force runs
  // BEFORE this route), Mark-as-Picked-Up (complete-pickup), or dispatch with
  // tracking (create-shipment / TrackingModal → create-fulfillment-force).
  // All three paths have a reservations preamble that tolerates (and prefers)
  // a surviving reservation. The old blanket release here minted phantom
  // available-to-sell during the invoice→fulfillment window (order #2549).

  // ── 24h Path B audit log ─────────────────────────────────────────────────
  // Persist inputs and decision for the SR vs Invoice path so we can debug
  // spurious downgrades. Each insert also deletes rows older than 24h —
  // self-cleaning, no cron required. Best-effort: never fails invoice creation.
  // TODO: remove this block + the qb_invoice_path_audit table once the bug is
  // confirmed fixed (see migration 1777580000000-CreateInvoicePathAudit).
  try {
    const auditPool = req.scope.resolve("__pg_connection__") as any;
    await auditPool.raw(
      `DELETE FROM qb_invoice_path_audit WHERE created_at < NOW() - INTERVAL '24 hours'`
    );
    await auditPool.raw(
      `INSERT INTO qb_invoice_path_audit
        (order_id, invoice_id, invoice_number,
         body_is_sales_receipt, final_is_sales_receipt, path_b_triggered,
         has_existing_qb_doc, has_existing_qb_doc_keys,
         age_ms, has_pending_so_in_pipeline,
         request_body, order_metadata_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb)`,
      [
        body.order_id,
        (invoice as any).id,
        invoice_number,
        bodyIsSalesReceiptAtEntry,
        !!body.is_sales_receipt,
        pathBAudit.path_b_triggered,
        pathBAudit.has_existing_qb_doc,
        JSON.stringify(pathBAudit.has_existing_qb_doc_keys ?? null),
        pathBAudit.age_ms,
        pathBAudit.has_pending_so_in_pipeline,
        JSON.stringify({
          order_id: body.order_id,
          customer_id: body.customer_id,
          total: body.total,
          amount_paid: body.amount_paid,
          payment_method: body.payment_method,
          card_brand: body.card_brand,
          terminal_payment_id: body.terminal_payment_id ?? null,
          is_sales_receipt: bodyIsSalesReceiptAtEntry,
          item_count: Array.isArray(body.items) ? body.items.length : 0,
        }),
        JSON.stringify(pathBAudit.order_metadata_snapshot ?? null),
      ]
    );
  } catch (auditErr: any) {
    console.warn(
      `[invoice] Path B audit log failed for order ${body.order_id}: ${auditErr.message}`
    );
  }

  // Helper mapper for methods — maps the normalized pos payment_method into the
  // customer_payment.method DB enum (which has its own accepted value set).
  function mapPosMethodToDbEnum(method: string): any {
    if (method === "credit_card" || method === "debit_card") return method;
    if (
      [
        "visa",
        "mastercard",
        "discover",
        "amex",
        "capital_one",
        "card",
      ].includes(method)
    )
      return "card"; // Legacy — backfill normalizes these post-migration.
    if (
      [
        "e_check",
        "checking_account",
        "transfer",
        "wire_transfer",
        "ach",
      ].includes(method)
    )
      return "ach";
    if (["paypal", "money_order"].includes(method)) return "other";
    if (method === "credit" || method === "credit_memo") return "credit_memo";
    if (["cash", "check", "zelle"].includes(method)) return method;
    return "other";
  }

  // Step 3: If an initial payment amount is sent, record it in ALL ledgers
  if (body.amount_paid > 0) {
    if (!resolvedPaymentMethod) {
      return res.status(400).json({
        error:
          "payment_method is required when amount_paid > 0 (skip-payment invoices must send amount_paid: 0)",
      });
    }
    const paymentDate = new Date();

    // A. PosInvoice internal payment record
    await invoiceService.createInvoicePayments({
      invoice_id: (invoice as any).id,
      amount: body.amount_paid,
      payment_method: resolvedPaymentMethod,
      notes: "Initial payment at issuance",
      created_by: body.created_by ?? null,
      paid_at: paymentDate,
    });
    // 'credit' = store credit (legacy naming, NOT a credit card). Consume path
    // is gated on that string; credit_card goes through the normal create path.
    if (resolvedPaymentMethod === "credit") {
      // Consume existing available credit instead of creating a new payment
      const availablePayments = await financeService.listCustomerPayments(
        { customer_id: body.customer_id },
        { relations: ["applications"] }
      );

      let amountToFind = body.amount_paid;
      for (const p of availablePayments) {
        if (amountToFind <= 0) break;
        if (p.status === "available" || p.status === "partially_applied") {
          const totalApplied = p.applications
            .filter((app: any) => !app.voided_at)
            .reduce(
              (sum: number, app: any) => sum + Number(app.amount_applied),
              0
            );

          const remaining = Number(p.amount) - totalApplied;
          if (remaining > 0) {
            const applyAmount = Math.min(remaining, amountToFind);

            const application = await financeService.createPaymentApplications({
              payment_id: p.id,
              invoice_id: (invoice as any).id,
              invoice_number: String(
                invoice_number || body.order_display_id || ""
              ),
              order_id: body.order_id,
              amount_applied: applyAmount,
              applied_at: paymentDate,
              applied_by: body.created_by || null,
            });

            applicationsToEmit.push({
              payment_id: p.id,
              invoice_id: (invoice as any).id,
              order_id: body.order_id,
              amount_applied: applyAmount,
              application_id: application.id,
            });

            const newRemaining = remaining - applyAmount;
            await financeService.updateCustomerPayments({
              id: p.id,
              status: newRemaining <= 0 ? "applied" : "partially_applied",
            });

            // If this available payment is a real money movement (type="payment",
            // e.g. a terminal capture that was left as "available") and hasn't been
            // synced to QB yet, it still needs a ReceivePayment in QB — treat it
            // exactly like a terminal_payment_id so the QB pipeline picks it up.
            // credit_memo / refund types are already in QB as Credit Memos; skip.
            const needsQbSync =
              (p as any).type === "payment" &&
              (p as any).metadata?.qb_sync_status !== "synced" &&
              !paymentIdToEmit; // only set once — first unsynced payment wins
            if (needsQbSync) {
              paymentIdToEmit = p.id;
              nextPayNum = (p as any).display_id
                ? Number((p as any).display_id)
                : null;
            }

            amountToFind -= applyAmount;
          }
        }
      }
    } else if (body.terminal_payment_id) {
      // B-terminal. The CustomerPayment was already created by the terminal route.
      // Just link it to this invoice via a PaymentApplication — no new payment row.
      // termPay was retrieved upfront (before createPosInvoices) to propagate
      // the terminal's source-of-truth method/brand into pos_invoice. Reuse it
      // here for the SR tagging + display_id lookup.

      // For sales receipts the QB handler embeds the payment internally (same as the
      // manual flow), so we must NOT set paymentIdToEmit — otherwise handlePosPaymentCreated
      // would fire a second time and create a duplicate QB entry.
      if (!body.is_sales_receipt) {
        paymentIdToEmit = body.terminal_payment_id;
        nextPayNum = termPay?.display_id ? Number(termPay.display_id) : null;
      } else {
        // Sales Receipt: tag the terminal payment so it is treated as embedded.
        // This prevents handlePosPaymentCreated from ever creating a separate
        // ReceivePayment in QB for this payment, and gives the SR handler a way
        // to locate and txn-id the payment after the SR confirms.
        try {
          await financeService.updateCustomerPayments({
            id: body.terminal_payment_id,
            metadata: {
              ...((termPay as any)?.metadata || {}),
              qb_source: "sales_receipt",
              qb_sync_status: "pending_sr",
              // Tag required by the PATCH /customer-payments/:id route to take the
              // SalesReceiptMod branch when a staff member later edits the payment
              // method. Without this flag the PATCH falls through to ReceivePaymentMod
              // using the SR's qb_txn_id, which would target the wrong QB entity.
              is_sales_receipt_payment: true,
              invoices_affected: [(invoice as any).id],
              invoices_affected_friendly: [
                `IN-${invoice_number || body.order_display_id}`,
              ],
            },
          });
        } catch (tagErr: any) {
          console.warn(
            `[invoice] Could not tag terminal payment ${body.terminal_payment_id} as SR-embedded: ${tagErr.message}`
          );
        }
      }

      // CONVERT-ON-APPLY: if this terminal payment was already auto-linked to
      // the order as an order-only reservation at checkout time (see store-pos
      // bams/terminal route's registerPayment), CONVERT that reservation to
      // invoice-bound instead of creating a second application — a second
      // INSERT would double-count the same cash in Treasury/AR. Mirrors
      // finance/payments/[id]/apply/route.ts's CONVERT-ON-APPLY block.
      const orderOnlyForOrder = (termPay?.applications ?? []).find(
        (a: any) =>
          !a.voided_at &&
          (a.invoice_id === null || a.invoice_id === undefined) &&
          a.order_id === body.order_id
      );

      let application: any;
      // Accumulate every invoice-bound application created/converted in this
      // step (normally exactly one, but the split/surplus sub-branches below
      // can produce two with DIFFERENT amounts) so the QB enqueue and the
      // payment status below reflect the real per-row amounts instead of
      // assuming a single application worth the full body.amount_paid.
      const boundApplications: Array<{ id: string; amount: number }> = [];
      if (orderOnlyForOrder) {
        const existingAmount = getNum(orderOnlyForOrder.amount_applied);
        const convertAmount = Math.min(body.amount_paid, existingAmount);

        if (convertAmount >= existingAmount) {
          // Convert the whole order-only reservation to invoice-bound.
          application = await financeService.updatePaymentApplications({
            id: orderOnlyForOrder.id,
            invoice_id: (invoice as any).id,
            invoice_number: String(
              invoice_number || body.order_display_id || ""
            ),
          });
          boundApplications.push({ id: application.id, amount: existingAmount });
        } else {
          // Partial: peel off an invoice-bound share, keep the remainder order-only.
          application = await financeService.createPaymentApplications({
            payment_id: body.terminal_payment_id,
            invoice_id: (invoice as any).id,
            invoice_number: String(
              invoice_number || body.order_display_id || ""
            ),
            order_id: body.order_id,
            amount_applied: convertAmount,
            applied_at: new Date(),
            applied_by: body.created_by || null,
            cost_snapshot: orderOnlyForOrder.cost_snapshot ?? null,
          });
          boundApplications.push({ id: application.id, amount: convertAmount });
          await financeService.updatePaymentApplications({
            id: orderOnlyForOrder.id,
            amount_applied: existingAmount - convertAmount,
          });
        }

        // If more was paid than the reservation covered, the surplus becomes a
        // fresh invoice-bound application (extra credit beyond the reservation).
        const surplus = body.amount_paid - convertAmount;
        if (surplus > 0) {
          const surplusApplication = await financeService.createPaymentApplications({
            payment_id: body.terminal_payment_id,
            invoice_id: (invoice as any).id,
            invoice_number: String(
              invoice_number || body.order_display_id || ""
            ),
            order_id: body.order_id,
            amount_applied: surplus,
            applied_at: new Date(),
            applied_by: body.created_by || null,
          });
          boundApplications.push({ id: surplusApplication.id, amount: surplus });
        }
      } else {
        application = await financeService.createPaymentApplications({
          payment_id: body.terminal_payment_id,
          invoice_id: (invoice as any).id,
          invoice_number: String(invoice_number || body.order_display_id || ""),
          order_id: body.order_id,
          amount_applied: body.amount_paid,
          applied_at: new Date(),
          applied_by: body.created_by || null,
        });
        boundApplications.push({ id: application.id, amount: body.amount_paid });
      }

      for (const bound of boundApplications) {
        applicationsToEmit.push({
          payment_id: body.terminal_payment_id,
          invoice_id: (invoice as any).id,
          order_id: body.order_id,
          amount_applied: bound.amount,
          application_id: bound.id,
        });
      }

      // Mark the terminal payment applied|partially_applied based on how much
      // of it is now bound to an invoice — mirrors the isFullyApplied check in
      // finance/payments/[id]/apply/route.ts. Previously this always set
      // "applied" unconditionally, which was only safe because the pre-fix
      // code always converted the ENTIRE payment in one INSERT; the
      // CONVERT-ON-APPLY path above can now leave a partial order-only
      // remainder (the `convertAmount < existingAmount` branch), so a payment
      // with money still order-reserved must not show as fully "applied" —
      // that would hide the remainder from available-credit lookups.
      const newlyBoundTotal = boundApplications.reduce(
        (sum, b) => sum + b.amount,
        0
      );
      // termPay is guaranteed non-null in this branch (mandatory retrieve
      // above) — the old `?? body.amount_paid` fallback forced isFullyApplied
      // to true whenever the read had failed, hiding any order-only remainder.
      const isFullyApplied =
        termPayInvoiceBoundApplied + newlyBoundTotal >= getNum(termPay.amount);
      await financeService.updateCustomerPayments({
        id: body.terminal_payment_id,
        status: isFullyApplied ? "applied" : "partially_applied",
      });

      // Register in Medusa native Payment Module so payment_collection.status → 'completed'.
      // The helper's cumulative-gap guard skips if this deposit/terminal payment was
      // already captured natively at apply-time (prevents the deposit double-capture).
      const medusaPaymentId = await registerMedusaPayment(req.scope, {
        order_id: body.order_id,
        amount: body.amount_paid,
        payment_method: resolvedPaymentMethod,
        invoice_total: body.total,
        customer_payment_id: body.terminal_payment_id,
      });
      if (medusaPaymentId) {
        await financeService.updateCustomerPayments({
          id: body.terminal_payment_id,
          medusa_payment_synced: true,
        });
      }
    } else {
      // Fetch strictly continuous sequential payment number
      const seqPgRes = await pgConnection
        .raw(`SELECT nextval('custom_payment_seq') AS seq`)
        .catch(() => ({ rows: [{ seq: null }] }));
      nextPayNum =
        seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ
          ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ)
          : null;

      // B. Finance Module global AR Ledger (New Money via Cash/Card/etc)
      const customerPayment = await financeService.createCustomerPayments({
        customer_id: body.customer_id,
        display_id: nextPayNum,
        amount: body.amount_paid,
        method: mapPosMethodToDbEnum(resolvedPaymentMethod),
        card_brand: resolvedCardBrand,
        reference: "Deposit",
        notes: "Initial invoice payment via Complete Order",
        received_at: paymentDate,
        created_by: body.created_by || null,
        source: "pos",
        type: "payment",
        status: "applied",
        medusa_payment_synced: false, // will be updated after Medusa sync
        metadata: {
          deposit_type: "INVOICE",
          order_id: body.order_id,
          order_display_id: body.order_display_id,
          pos_payment_method: resolvedPaymentMethod,
          card_brand: resolvedCardBrand,
          invoices_affected: [(invoice as any).id],
          invoices_affected_friendly: [
            `IN-${invoice_number || body.order_display_id}`,
          ],
          order_document_number: body.order_document_number ?? null,
          ...(body.is_sales_receipt
            ? {
                qb_txn_id: "SYNCED_VIA_RECEIPT",
                is_sales_receipt_payment: true,
              }
            : {
                ...(process.env.QB_ORDER_FLOW_ENABLED === "true"
                  ? { qb_sync_status: "pending" }
                  : {}),
              }),
        },
      });

      // Fire event so QuickBooks catches the POS payment immediately (deferred to end of route)
      const paymentId = Array.isArray(customerPayment)
        ? customerPayment[0]?.id
        : customerPayment?.id;
      console.log("================= CUSTOMER PAYMENT DEBUG =================");
      console.log("customerPayment:", JSON.stringify(customerPayment));
      console.log("resolved paymentId:", paymentId);
      console.log("=====================================================");
      if (paymentId) {
        if (body.is_sales_receipt) {
          console.log(
            "PAYMENT SKIPPED FOR EMIT: Sales receipt covers payment automatically."
          );
        } else {
          paymentIdToEmit = paymentId;
        }
      } else {
        console.log("paymentId WAS FALSEY! SKIPPING EMIT!");
      }

      // C. Finance Application
      const application = await financeService.createPaymentApplications({
        payment_id: customerPayment.id,
        invoice_id: (invoice as any).id,
        invoice_number: String(invoice_number || body.order_display_id || ""),
        order_id: body.order_id,
        amount_applied: body.amount_paid,
        applied_at: paymentDate,
        applied_by: body.created_by || null,
      });

      applicationsToEmit.push({
        payment_id: customerPayment.id,
        invoice_id: (invoice as any).id,
        order_id: body.order_id,
        amount_applied: body.amount_paid,
        application_id: application.id,
      });

      // D. Register in Medusa native Payment Module (best-effort)
      const medusaPaymentId = await registerMedusaPayment(req.scope, {
        order_id: body.order_id,
        amount: body.amount_paid,
        payment_method: resolvedPaymentMethod,
        invoice_total: body.total,
        customer_payment_id: customerPayment.id,
      });
      if (medusaPaymentId) {
        await financeService.updateCustomerPayments({
          id: customerPayment.id,
          medusa_payment_synced: true,
        });
      }
    }

    // Update order.metadata.referential_deposit so the POS order list "DEPOSIT" column
    // reflects money received for this order regardless of capture path (cash/check at
    // Create Invoice, credit consume, etc). Terminal flow already writes this field
    // at capture time in store-pos/.../bams/terminal/route.ts, so we skip when a
    // terminal_payment_id was used — prevents double-counting.
    if (!body.terminal_payment_id) {
      try {
        const orderModule = req.scope.resolve(Modules.ORDER);
        const currentOrder = (await orderModule.retrieveOrder(body.order_id, {
          select: ["id", "metadata"],
        })) as any;
        const existingMeta = currentOrder?.metadata ?? {};
        const currentDepositDollars = Number(
          existingMeta.referential_deposit ?? 0
        );
        const incrementDollars = body.amount_paid / 100;
        const newDepositDollars = Number(
          (currentDepositDollars + incrementDollars).toFixed(2)
        );
        await orderModule.updateOrders(body.order_id, {
          metadata: {
            ...existingMeta,
            referential_deposit: newDepositDollars,
          },
        });
      } catch (depErr: any) {
        console.warn(
          `[invoice] Failed to update order referential_deposit for ${body.order_id}: ${depErr.message}`
        );
      }
    }
  }

  // ── Fase 3: QB items readiness gate ────────────────────────────────────────
  // If any variant in this invoice was recently created via POS Product V2 and
  // has not yet received its QuickBooks ListID (metadata.quickbooks_id), defer
  // the entire QB dispatch. The invoice creates, the cashier can charge/print,
  // but the SalesReceipt/Invoice push to QB is held until every variant has a
  // ListID. The waiting-gate poller (qb-invoice-waiting-gate.ts) promotes the
  // invoice once ready.
  let waitingForQbItems = false;
  try {
    const variantIds = (body.items ?? [])
      .map((it) => it.variant_id)
      .filter((x): x is string => !!x);
    if (variantIds.length > 0) {
      const vRes = await pgConnection.raw(
        `SELECT id, metadata FROM product_variant WHERE id = ANY(?::text[])`,
        [variantIds]
      );
      const missing = ((vRes.rows ?? []) as any[])
        .filter((v) => !v.metadata?.quickbooks_id)
        .map((v) => v.id);
      if (missing.length > 0) {
        waitingForQbItems = true;
        const existingMeta = (invoice as any).metadata ?? {};
        await invoiceService.updatePosInvoices({
          id: (invoice as any).id,
          metadata: {
            ...existingMeta,
            waiting_qb_items: true,
            waiting_variant_ids: missing,
            qb_dispatch_payload: {
              is_sales_receipt: !!body.is_sales_receipt,
              fulfillment_id: body.fulfillment_id ?? null,
              resolved_payment_method: resolvedPaymentMethod,
              payment_id_to_emit: paymentIdToEmit,
              applications_to_emit: applicationsToEmit,
              next_pay_num: nextPayNum,
              invoice_number,
            },
          },
        });
        console.log(
          `[invoice] Deferring QB sync for invoice ${(invoice as any).id} — ${missing.length} variant(s) waiting for ListID`
        );
      }
    }
  } catch (gateErr: any) {
    console.warn(
      `[invoice] QB items gate check failed, proceeding with normal dispatch: ${gateErr.message}`
    );
  }

  // Write upfront pipeline rows immediately so the UI shows the complete expected flow
  // before any QB handler runs. Each row starts as 'waiting' and transitions in-place.
  if (!waitingForQbItems && process.env.QB_ORDER_FLOW_ENABLED === "true") {
    try {
      if (body.is_sales_receipt) {
        // ── Sales Receipt flow ────────────────────────────────────────
        // Payment is embedded in the Sales Receipt — QB handles it internally.
        // Cancel any stale/preexisting payment pipeline rows first (e.g. from
        // terminal capture that wrote a row before the SR decision was made).
        try {
          const cancelled = await skipPendingPaymentRows(
            body.order_id,
            "Superseded by Sales Receipt — payment embedded in SR"
          );
          if (cancelled > 0) {
            console.log(
              `[invoice] Skipped ${cancelled} stale payment pipeline rows for order ${body.order_id}`
            );
          }
        } catch (clErr: any) {
          console.warn(
            `[invoice] Could not skip stale payment rows: ${clErr.message}`
          );
        }

        await writePipelineRow({
          orderId: body.order_id,
          referenceId: (invoice as any).id,
          referenceType: "pos_invoice",
          step: "sales_receipt",
          status: "waiting",
          medusaRefNumber: `INV-${invoice_number}`,
        });
      } else {
        // ── Invoice flow ──────────────────────────────────────────────
        // 1. Invoice row — waiting. No SO dependency (independent QB doc).
        const invoicePipelineRowId = await writePipelineRow({
          orderId: body.order_id,
          referenceId: (invoice as any).id,
          referenceType: "pos_invoice",
          step: "invoice",
          status: "waiting",
          medusaRefNumber: `INV-${invoice_number}`,
        });

        // 2. Payment row — waiting (only for non-credit new payments)
        if (paymentIdToEmit) {
          await writePipelineRow({
            orderId: body.order_id,
            referenceId: paymentIdToEmit,
            referenceType: "customer_payment",
            step: "payment",
            status: "waiting",
            medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
          });
        }

        // 3. Apply-payment row — one per application.
        // Apply Payment must always wait for the Invoice to be confirmed in QB first —
        // QB Desktop cannot apply a payment to an invoice that doesn't exist yet.
        // The Payment row confirms faster than the Invoice in practice, so by the time
        // the Invoice is confirmed the Payment TxnID is already available.
        for (const app of applicationsToEmit) {
          // CANONICAL apply_payment keying (dual-keying dup fix):
          // Key this upfront waiting row by the payment_application (papp_), NOT
          // the customer_payment (cpay_). The direct-exec handler below resolves
          // the papp_ id via resolveCanonicalApplyPaymentRef, so keying the
          // upfront row by cpay_ produced a SECOND apply_payment row that
          // writePipelineRow's (order_id, reference_id, step) dedup couldn't
          // collapse and the papp_ partial-unique index couldn't catch. Both
          // rows then dispatched a ReceivePaymentMod against the same QB
          // ReceivePayment → the loser failed with QB 3200 "stale edit sequence"
          // (harmless-but-visible), or both confirmed via the idempotent merge
          // (silent redundant dispatch). Keying by papp_ makes this waiting row
          // dedup in-place with the handler's row → exactly ONE apply_payment.
          const applyRefId = (app.application_id ?? app.payment_id) as string;
          const applyRefType = app.application_id
            ? ("payment_application" as const)
            : ("customer_payment" as const);
          // medusa_ref is the PAY-#### number → always resolve from the payment.
          let applyMedusaRef: string | null =
            paymentIdToEmit && app.payment_id === paymentIdToEmit && nextPayNum
              ? `PAY-${nextPayNum}`
              : null;
          if (!applyMedusaRef && app.payment_id) {
            try {
              const payRes = await pgConnection.raw(
                `SELECT display_id FROM customer_payment WHERE id = ?`,
                [app.payment_id]
              );
              if (payRes.rows[0]?.display_id)
                applyMedusaRef = `PAY-${payRes.rows[0].display_id}`;
            } catch {}
          }
          await writePipelineRow({
            orderId: body.order_id,
            referenceId: applyRefId,
            referenceType: applyRefType,
            step: "apply_payment",
            status: "waiting",
            dependsOn: invoicePipelineRowId,
            medusaRefNumber: applyMedusaRef,
          });
        }
      }
      // Skip the Sales Order pipeline row for this order — a full invoice/sales receipt
      // supersedes the need for a QB Sales Order. Do this immediately so the cron never
      // picks up the order for SO creation.
      try {
        await skipSalesOrderPipelineRow(body.order_id);
      } catch (skipErr: any) {
        console.warn("Could not skip SO pipeline row:", skipErr.message);
      }
    } catch (upfrontErr: any) {
      console.error(
        "Failed to write upfront pipeline rows:",
        upfrontErr.message
      );
    }
  }

  // Use direct background execution (Event Loop) to guarantee 100% reliable QuickBooks Syncing,
  // thereby bypassing the Medusa v2 BullMQ Outbox which silently drops multiple sequential events.
  // Skipped when the QB items gate fired above — the waiting-gate poller will dispatch later.
  if (!waitingForQbItems)
    setTimeout(async () => {
      try {
        const container = req.scope;
        // 1.5.7: orderModule + customerModule + logger no longer needed at
        // this scope — handler calls replaced with pipeline enqueue. The
        // container is still used downstream for events / payment dispatch.

        // 1. Process Order Document (Invoice or Sales Receipt)
        if (body.is_sales_receipt) {
          console.log(
            `1.5.6: Enqueuing sales_receipt pipeline row for order ${body.order_id}.`
          );
          const {
            writePipelineRow: enqueueSrInv,
          } = require("../../../lib/quickbooks/qb-pipeline");
          await enqueueSrInv({
            orderId: body.order_id,
            referenceId: (invoice as any).id,
            referenceType: "invoice",
            step: "sales_receipt",
            status: "pending",
            payload: {
              invoice_id: (invoice as any).id,
              items: body.items,
              fulfillment_id: body.fulfillment_id,
              // resolvedPaymentMethod (terminal-detected) takes precedence
              // over the stale body field.
              payment_method: resolvedPaymentMethod,
              payment_id: paymentIdToEmit,
            },
          });
        } else {
          console.log(
            `1.5.7: Enqueuing invoice pipeline row for order ${body.order_id}.`
          );
          // 1.5.7: pipeline-only — consolidator processes via pending-dispatch.
          const {
            writePipelineRow: enqueueInvR,
          } = require("../../../lib/quickbooks/qb-pipeline");
          await enqueueInvR({
            orderId: body.order_id,
            referenceId: (invoice as any).id,
            referenceType: "invoice",
            step: "invoice",
            status: "pending",
            payload: {
              invoice_id: (invoice as any).id,
              items: body.items,
              fulfillment_id: body.fulfillment_id,
            },
          });
        }

        // Wait 250ms to ensure sequential QB database writing
        await new Promise((r) => setTimeout(r, 250));

        // 2. Process Payment Creation
        if (paymentIdToEmit) {
          await handlePosPaymentCreated({
            event: {
              name: "pos.payment.created",
              data: { id: paymentIdToEmit },
            },
            container,
          } as any);
          console.log(
            "DIRECT EXEC: pos.payment.created executed successfully!"
          );
        }

        // Wait 250ms again
        await new Promise((r) => setTimeout(r, 250));

        // 3. Process Applications — run in parallel so multiple payments don't
        //    block each other (each may poll the bridge for up to 400s).
        if (applicationsToEmit.length > 0) {
          if (body.is_sales_receipt) {
            console.log(
              "DIRECT EXEC: Skipping pos.payment.applied emit because this is a Sales Receipt."
            );
          } else {
            // Guard: only run apply_payment immediately if the new payment is already
            // confirmed in QB. When handlePosPaymentCreated short-circuits (idempotency —
            // finance/payments/route.ts already started it), the payment is still being
            // processed asynchronously. Running apply_payment now would poll for 400s and
            // fail. The upfront `apply_payment` waiting row already has depends_on pointing
            // to the payment row, so wakeDependentsOfConfirmed will trigger it correctly
            // once the payment confirms.
            let paymentReadyForDirectApply = !paymentIdToEmit; // true when no payment step needed
            if (paymentIdToEmit) {
              try {
                const finSvcCheck = container.resolve(FINANCE_MODULE) as any;
                const [freshPay] = await finSvcCheck.listCustomerPayments({
                  id: paymentIdToEmit,
                });
                paymentReadyForDirectApply =
                  freshPay?.metadata?.qb_sync_status === "synced";
              } catch {
                paymentReadyForDirectApply = false;
              }
            }

            if (!paymentReadyForDirectApply) {
              console.log(
                "DIRECT EXEC: Payment not yet confirmed in QB — apply_payment deferred to waiting gate (depends_on payment row)"
              );
            } else {
              await Promise.all(
                applicationsToEmit.map(async (appPayload) => {
                  await handlePosPaymentApplied({
                    event: { name: "pos.payment.applied", data: appPayload },
                    container,
                  } as any);
                  console.log(
                    `DIRECT EXEC: pos.payment.applied executed for Payment ${appPayload.payment_id}!`
                  );
                })
              );
            }
          }
        }
      } catch (execErr: any) {
        console.error("DIRECT EXEC ERROR:", execErr);
      }
    }, 100);

  // Auto-update order.metadata.order_status based on delivery type + fulfillment result.
  // Priority: Voided (no-op) > shipping → "Ready to Ship" > fulfilled pickup → "Fulfilled" > default "Approved".
  // Non-fatal: invoice already committed; a status-write failure never blocks the 201 response.
  try {
    const PICKUP_KEYWORDS = [
      "pickup",
      "pick up",
      "pick-up",
      "store pickup",
      "local pickup",
      "in-store",
      "miami",
    ];
    const orderModForStatus = req.scope.resolve(Modules.ORDER);
    const orderForStatus = (await orderModForStatus.retrieveOrder(
      body.order_id,
      {
        select: ["id", "fulfillment_status", "metadata"],
        relations: ["shipping_methods"],
      }
    )) as any;

    const existingOrderStatus: string | undefined =
      orderForStatus?.metadata?.order_status;
    if (existingOrderStatus !== "Voided") {
      const shippingMethods: Array<{ name?: string }> =
        orderForStatus?.shipping_methods ?? [];
      const isPickup =
        shippingMethods.length > 0 &&
        shippingMethods.some((m) =>
          PICKUP_KEYWORDS.some((kw) =>
            (m?.name ?? "").toLowerCase().includes(kw)
          )
        );
      const isShipping = shippingMethods.length > 0 && !isPickup;
      // query.graph silently drops the computed fulfillment_status getter.
      // Use SQL to check whether all order items are fulfilled instead.
      let isFullyFulfilled = false;
      try {
        const fulfillCheckForStatus = await pgConnection.raw(
          `SELECT COUNT(*) FILTER (WHERE oi.fulfilled_quantity < oi.quantity) AS unfulfilled
           FROM order_item oi WHERE oi.order_id = ?`,
          [body.order_id]
        );
        isFullyFulfilled =
          Number(fulfillCheckForStatus.rows[0]?.unfulfilled ?? 1) === 0;
      } catch {
        /* fail-open: default to Approved */
      }

      let derivedOrderStatus: string;
      if (isShipping) {
        derivedOrderStatus = "Ready to Ship";
      } else if (body.fulfillment_id && isFullyFulfilled) {
        derivedOrderStatus = "Fulfilled";
      } else {
        derivedOrderStatus = "Approved";
      }

      await orderModForStatus.updateOrders(body.order_id, {
        metadata: {
          ...(orderForStatus?.metadata ?? {}),
          order_status: derivedOrderStatus,
        },
      });
      console.log(
        `[invoice] order_status auto-set to "${derivedOrderStatus}" for order ${body.order_id}`
      );
    }
  } catch (statusErr: any) {
    console.warn(
      `[invoice] Failed to auto-set order_status for ${body.order_id}: ${statusErr.message}`
    );
  }

  // Re-fetch with relations for the response
  const full = await invoiceService
    .retrievePosInvoice((invoice as any).id, {
      relations: ["items"],
    })
    .catch(() => invoice);

  // Emit pos.invoice.created so downstream subscribers (Meilisearch sync,
  // future hooks) can react. Best-effort — never fails the response.
  try {
    const eventBus = req.scope.resolve(Modules.EVENT_BUS);
    await eventBus.emit({
      name: "pos.invoice.created",
      data: {
        id: (invoice as any).id,
        invoice_id: (invoice as any).id,
        order_id: body.order_id,
        is_sales_receipt: body.is_sales_receipt === true,
      },
    });
  } catch (emitErr: any) {
    console.warn(
      `[invoice] pos.invoice.created emit failed: ${emitErr?.message}`
    );
  }

  // Best-effort native completion. If this invoice already makes the order fully
  // fulfilled + paid, close it now (maybeCompleteOrder runs all guards + holds a
  // session advisory lock + is idempotent). The auto-complete subscriber
  // (pos.invoice.created / order.payment_captured / order.updated …) is the
  // durable retry net for the common case where the terminal payment capture
  // settles a beat after invoice creation. Awaited but non-fatal — never blocks
  // the 201. Replaces the old fragile one-shot setTimeout (no retry → orphans).
  try {
    await maybeCompleteOrder(req.scope, body.order_id);
  } catch (closeErr: any) {
    console.warn(
      `[invoice] auto-complete attempt failed (non-fatal): ${closeErr?.message?.slice(0, 120)}`
    );
  }

  // Reservation hygiene: invoicing raises invoice-bound consumption, which
  // lowers what the order still needs reserved — release any order-only
  // remainder that exceeds it (e.g. a $1000 reservation on an order reduced
  // to $600: the CONVERT above bound $600; the $400 leftover returns to the
  // payment's available pool here). Non-fatal.
  try {
    await reconcileOrderReservations(req.scope, body.order_id, {
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    });
  } catch (reconErr: any) {
    console.warn(
      `[invoice] reservation reconcile failed (non-fatal): ${reconErr?.message?.slice(0, 120)}`
    );
  }

  return res.status(201).json({ invoice: full });
}
