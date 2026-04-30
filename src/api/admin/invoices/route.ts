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
import { FINANCE_MODULE } from "../../../modules/finance";
import { INVOICE_MODULE } from "../../../modules/invoices";

import { registerMedusaPayment } from "./register-medusa-payment";
// ── GET /admin/invoices?order_id=:id ─────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);
  const { order_id, customer_id, created_at, status, limit, offset } =
    req.query as Record<string, any>;

  const filters: Record<string, unknown> = {};
  if (order_id) filters.order_id = order_id;
  if (customer_id) filters.customer_id = customer_id;
  if (created_at) filters.created_at = created_at;
  if (status) filters.status = status;

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
    customer: customerMap[inv.customer_id] ?? null,
  }));

  return res.json({ invoices: enriched });
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
    total: number; // cents
  }>;
  subtotal: number; // cents
  discount?: number; // cents
  shipping: number; // cents
  tax: number; // cents
  total: number; // cents
  amount_paid: number; // cents
  payment_method: // Canonical values — new callers should send these.
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
    | "credit_memo";
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

  // ── Idempotency: a terminal_payment_id can only be applied to ONE invoice ──
  // The terminal route already created a CustomerPayment when the card was
  // charged. If the client retries this POST (browser double-click, network
  // retry, recovery button), we must NOT create a second invoice — it would
  // consume two sequence numbers and leave an orphan Sales Receipt in QB.
  // Runs BEFORE nextval() so we don't burn invoice/SR sequence numbers on retries.
  if (body.terminal_payment_id) {
    try {
      const existingApplications = await financeService.listPaymentApplications(
        {
          payment_id: body.terminal_payment_id,
        }
      );
      if (existingApplications.length > 0) {
        const existingInvoiceId = (existingApplications[0] as any).invoice_id;
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
      // Non-fatal — fall through to normal creation path. Worst case: duplicate
      // invoice if the listPaymentApplications call was transiently broken, but
      // that's no worse than the pre-idempotency behavior.
      console.warn(
        `[invoice] Idempotency check failed for terminal_payment ${body.terminal_payment_id}: ${idemErr.message}`
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

  // Fetch strictly continuous sequential document number from PostgreSQL
  const pgConnection = req.scope.resolve("__pg_connection__") as any;

  // 1. Get Medusa Invoice Sequence
  const medusaSeqRes = await pgConnection.raw(
    `SELECT nextval('custom_medusa_invoice_seq') AS seq`
  );
  const invoice_number = `${medusaSeqRes.rows[0].seq || medusaSeqRes.rows[0].SEQ}`;

  // 2. Get QB RefNumber Sequence
  const targetSeq = body.is_sales_receipt
    ? "custom_sales_receipt_seq"
    : "custom_invoice_seq";
  const seqRes = await pgConnection.raw(
    `SELECT nextval('${targetSeq}') AS seq`
  );
  const nextInvNum = seqRes.rows[0].seq || seqRes.rows[0].SEQ;
  const qb_metadata_ref_number = `${nextInvNum}`;

  const balance_due = body.total - body.amount_paid;

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
  let normalizedPaymentMethod: string = body.payment_method;
  let normalizedCardBrand: string | null = body.card_brand ?? null;
  if (CARD_BRANDS.has(body.payment_method)) {
    normalizedPaymentMethod = "credit_card";
    normalizedCardBrand = body.payment_method;
  }

  let paymentIdToEmit: string | null = null;
  let nextPayNum: number | null = null;
  const applicationsToEmit: any[] = [];
  // The QB Sales Receipt needs the exact card type (e.g. 'mastercard') to pick the
  // correct Payment Method in QuickBooks. body.payment_method can be stale ('card',
  // 'cash' default, etc.) when the Dejavoo terminal fires the auto-submit. For
  // terminal-sourced payments we override this with the card type that Dejavoo
  // actually reported, stored on the customer_payment metadata.
  let resolvedPaymentMethod: string = normalizedPaymentMethod;
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
    try {
      termPay = await financeService.retrieveCustomerPayment(
        body.terminal_payment_id
      );
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
    } catch (tpErr: any) {
      console.warn(
        `[invoice] Could not read terminal_payment metadata for ${body.terminal_payment_id}: ${tpErr.message}`
      );
    }
  }

  // Step 1: Create the invoice (no nested items — hasMany must be created separately)
  const initialStatus =
    balance_due <= 0 ? "paid" : body.amount_paid > 0 ? "partial" : "issued";

  const invoice = await invoiceService.createPosInvoices({
    invoice_number,
    order_id: body.order_id,
    fulfillment_id: body.fulfillment_id ?? null,
    customer_id: body.customer_id,
    status: initialStatus as "issued" | "paid" | "partial",
    subtotal: body.subtotal,
    discount: body.discount ?? 0,
    shipping: body.shipping ?? 0,
    tax: body.tax,
    untaxed_total: body.total - body.tax,
    total: body.total,
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
  });

  // Step 2: Create line items linked to the invoice
  if (body.items?.length) {
    await invoiceService.createPosInvoiceItems(
      body.items.map((it) => ({
        invoice_id: (invoice as any).id,
        variant_id: it.variant_id ?? null,
        sku: it.sku ?? null,
        description: it.description,
        quantity: it.quantity,
        unit_price: it.unit_price,
        total: it.total,
      }))
    );
  }

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

      const application = await financeService.createPaymentApplications({
        payment_id: body.terminal_payment_id,
        invoice_id: (invoice as any).id,
        invoice_number: String(invoice_number || body.order_display_id || ""),
        order_id: body.order_id,
        amount_applied: body.amount_paid,
        applied_at: new Date(),
        applied_by: body.created_by || null,
      });

      applicationsToEmit.push({
        payment_id: body.terminal_payment_id,
        invoice_id: (invoice as any).id,
        order_id: body.order_id,
        amount_applied: body.amount_paid,
        application_id: application.id,
      });

      // Always mark the terminal payment as fully applied once we link it,
      // regardless of SR or regular-invoice mode. Previously this only ran in
      // the non-SR branch, leaving SR-linked payments stuck on status='available'.
      await financeService.updateCustomerPayments({
        id: body.terminal_payment_id,
        status: "applied",
      });

      // Register in Medusa native Payment Module so payment_collection.status → 'completed'
      const medusaPaymentId = await registerMedusaPayment(req.scope, {
        order_id: body.order_id,
        amount: body.amount_paid,
        payment_method: resolvedPaymentMethod,
        invoice_total: body.total,
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
          const applyPayRef = app.payment_id;
          // Use nextPayNum only for the newly-created payment; look up others
          let applyMedusaRef: string | null =
            paymentIdToEmit && app.payment_id === paymentIdToEmit && nextPayNum
              ? `PAY-${nextPayNum}`
              : null;
          if (!applyMedusaRef && applyPayRef) {
            try {
              const payRes = await pgConnection.raw(
                `SELECT display_id FROM customer_payment WHERE id = ?`,
                [applyPayRef]
              );
              if (payRes.rows[0]?.display_id)
                applyMedusaRef = `PAY-${payRes.rows[0].display_id}`;
            } catch {}
          }
          await writePipelineRow({
            orderId: body.order_id,
            referenceId: applyPayRef,
            referenceType: "customer_payment",
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
      const fulfillmentStatus: string =
        orderForStatus?.fulfillment_status ?? "";

      let derivedOrderStatus: string;
      if (isShipping) {
        derivedOrderStatus = "Ready to Ship";
      } else if (
        body.fulfillment_id &&
        ["fulfilled", "delivered"].includes(fulfillmentStatus)
      ) {
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

  return res.status(201).json({ invoice: full });
}
