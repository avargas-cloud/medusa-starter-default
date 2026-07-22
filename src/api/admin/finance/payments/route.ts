import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

// 1.5.9: handlePosPaymentCreated import removed — finance/payments enqueues now.
import { writePipelineRow } from "../../../../lib/quickbooks/qb-pipeline";
import {
  computeBatchDay,
  getBatchCutoff,
} from "../../../../lib/finance/batch-day";
import { isTreasuryDayLocked } from "../../../../lib/finance/treasury-lock";
import { FINANCE_MODULE } from "../../../../modules/finance";

/**
 * GET /admin/finance/payments
 * Lists customer payments. Supports filtering by customer_id and status.
 * Applications are enriched with invoice_number from pos_invoice.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const { customer_id, status } = req.query as {
    customer_id?: string;
    status?: string;
  };

  const filters: any = {};
  if (customer_id) filters.customer_id = customer_id;
  if (status) filters.status = status;

  try {
    const payments = await financeService.listCustomerPayments(filters, {
      order: { received_at: "DESC" },
      relations: ["applications"],
    });

    // Collect all invoice_ids from applications that don't have invoice_number
    const invoiceIds = new Set<string>();
    for (const pay of payments) {
      for (const app of pay.applications ?? []) {
        if (app.invoice_id && !app.invoice_number) {
          invoiceIds.add(app.invoice_id);
        }
      }
    }

    // Bulk-lookup invoice numbers from pos_invoice
    const invoiceNumberMap: Record<string, string> = {};
    if (invoiceIds.size > 0) {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      try {
        await client.connect();
        const result = await client.query<{
          id: string;
          invoice_number: string;
        }>(`SELECT id, invoice_number FROM pos_invoice WHERE id = ANY($1)`, [
          Array.from(invoiceIds),
        ]);
        for (const row of result.rows) {
          invoiceNumberMap[row.id] = row.invoice_number;
        }
      } finally {
        await client.end();
      }
    }

    // Enrich applications with invoice_number
    const enriched = payments.map((pay: any) => ({
      ...pay,
      applications: (pay.applications ?? []).map((app: any) => ({
        ...app,
        invoice_number:
          app.invoice_number ||
          (app.invoice_id ? invoiceNumberMap[app.invoice_id] : null) ||
          null,
      })),
    }));

    return res.json({ payments: enriched });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /admin/finance/payments
 * Creates a new customer payment (e.g. a deposit or independent payment).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const {
    customer_id,
    amount,
    method,
    card_brand,
    reference,
    notes,
    received_at,
    created_by,
    source,
    type,
    metadata,
    skip_qb_sync,
    locked_order_id,
  } = req.body as any;

  if (!customer_id) {
    return res.status(400).json({ error: "customer_id is required" });
  }
  if (amount === undefined || amount < 0) {
    return res
      .status(400)
      .json({ error: "amount must be a non-negative number (cents)" });
  }

  // Map POS-specific methods to valid customer_payment.method enum values:
  //   ['credit_card', 'debit_card', 'cash', 'check', 'card', 'ach', 'zelle',
  //    'credit_memo', 'stripe', 'authorize_net', 'other']
  //
  // Legacy brand values (visa/mastercard/amex/discover/capital_one) are normalized
  // to 'credit_card' and the brand is extracted into mappedCardBrand for persistence.
  const CARD_BRAND_SET = new Set([
    "visa",
    "mastercard",
    "amex",
    "discover",
    "capital_one",
  ]);
  let mappedMethod = "other";
  let mappedCardBrand: string | null =
    typeof card_brand === "string" &&
    CARD_BRAND_SET.has(card_brand.toLowerCase())
      ? card_brand.toLowerCase()
      : null;
  const m = (method || "").toLowerCase();

  if (m === "credit_card" || m === "debit_card") {
    mappedMethod = m;
  } else if (
    m === "cash" ||
    m === "check" ||
    m === "zelle" ||
    m === "credit_memo"
  ) {
    mappedMethod = m;
  } else if (CARD_BRAND_SET.has(m)) {
    // Legacy: caller sent a brand as the method → normalize to credit_card + brand.
    mappedMethod = "credit_card";
    if (!mappedCardBrand) mappedCardBrand = m;
  } else if (m === "card") {
    // Legacy generic — keep 'card' for backward compatibility (historical rows).
    mappedMethod = "card";
  } else if (
    [
      "ach",
      "checking_account",
      "e_check",
      "transfer",
      "wire_transfer",
    ].includes(m)
  ) {
    mappedMethod = "ach";
  }

  // Backdated payments (explicit received_at whose batch day is behind the
  // natural one) must not land on a treasury day that is already confirmed
  // & locked — that cash would be invisible in the confirmed totals forever.
  // Real-time callers (received_at ≈ now, e.g. BAMS webhook/terminal) are
  // exempt: their target batch day is never behind the natural one.
  if (received_at) {
    try {
      const cutoff = await getBatchCutoff();
      const targetDay = computeBatchDay(new Date(received_at), cutoff);
      const naturalDay = computeBatchDay(new Date(), cutoff);
      if (targetDay < naturalDay && (await isTreasuryDayLocked(targetDay))) {
        return res.status(409).json({
          code: "TREASURY_DAY_LOCKED",
          error: `Treasury for ${targetDay} is already confirmed & locked. Pick a different payment date or ask accounting to unlock that day.`,
        });
      }
    } catch (guardErr: any) {
      // Non-fatal: recording the payment outranks the rare locked-day edge.
      console.warn(
        `[finance/payments] treasury-lock guard failed (allowing create): ${guardErr.message}`
      );
    }
  }

  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // Sequential payment number
    const seqRes = await pgConnection
      .raw(`SELECT nextval('custom_payment_seq') AS seq`)
      .catch(() => ({ rows: [{ seq: null }] }));
    const nextPayNum =
      seqRes.rows[0]?.seq || seqRes.rows[0]?.SEQ
        ? Number(seqRes.rows[0].seq || seqRes.rows[0].SEQ)
        : null;

    // Sequential transaction number — assign once per unique transaction_id
    let transactionNumber: number | null = null;
    const incomingTxnId = (metadata as any)?.transaction_id;
    if (incomingTxnId) {
      // Look for an existing payment in this transaction that already has a number
      const existing = await financeService
        .listCustomerPayments(
          { metadata: { transaction_id: incomingTxnId } } as any,
          { take: 1 }
        )
        .catch(() => []);
      const existingNum = (existing[0] as any)?.metadata?.transaction_number;
      if (existingNum) {
        transactionNumber = Number(existingNum);
      } else {
        const txnSeqRes = await pgConnection
          .raw(`SELECT nextval('pos_transaction_seq') AS seq`)
          .catch(() => ({ rows: [{ seq: null }] }));
        const raw = txnSeqRes.rows[0]?.seq ?? txnSeqRes.rows[0]?.SEQ;
        if (raw) transactionNumber = Number(raw);
      }
    }

    const qbFlowEnabled = process.env.QB_ORDER_FLOW_ENABLED === "true";

    // Persist the order this payment was captured against. The BAMS webhook and
    // the deposit modals send this so an estimate-time deposit can be linked at
    // convert-force time (see convert-force Step 4b, which finds deferred
    // deposits by locked_order_id). Falls back to metadata.order_id. Without
    // this, estimate deposits stayed unlinked until the order was invoiced
    // (root cause of PAY-3152 hanging in Treasury's unattributed panel).
    const resolvedLockedOrderId =
      locked_order_id || (metadata as any)?.order_id || null;

    const payment = await financeService.createCustomerPayments({
      customer_id,
      display_id: nextPayNum,
      amount,
      method: mappedMethod as any,
      card_brand: mappedCardBrand,
      reference: reference || null,
      notes: notes || null,
      locked_order_id: resolvedLockedOrderId,
      received_at: received_at ? new Date(received_at) : new Date(),
      created_by: created_by || null,
      source: source || "pos",
      type: type || "payment",
      metadata: {
        ...(metadata || {}),
        // Caller-provided pos_payment_method wins: the Dejavoo terminal route must
        // send method='card' (DB CHECK constraint) but stores the real card network
        // (e.g. 'visa', 'mastercard') in metadata.pos_payment_method as the source of
        // truth for QB. All other callers omit metadata.pos_payment_method and fall
        // back to `m` = lowercased top-level method (unchanged behavior).
        pos_payment_method: (metadata as any)?.pos_payment_method || m,
        ...(transactionNumber !== null
          ? { transaction_number: transactionNumber }
          : {}),
        // Show spinner immediately in the UI — the QB handler will update to 'synced'/'error'
        ...(qbFlowEnabled ? { qb_sync_status: "pending" } : {}),
      },
      status: "available", // A new manual payment is always available until applied
    });

    // Write upfront pipeline row + direct exec (bypasses BullMQ outbox).
    // skip_qb_sync=true is set by the terminal route — QB sync will be driven
    // by the invoice route once Invoice vs SR is decided (avoids duplicating
    // a standalone ReceivePayment alongside a SalesReceipt's embedded payment).
    //
    // The 'waiting' row is written unconditionally (even with skip_qb_sync=true)
    // so every cpay has an anchor in qb_order_pipeline from creation. Without
    // this anchor, an abandoned CompleteOrderModal (cobro succeeded → cashier
    // never reached /admin/invoices) leaves an orphan cpay with metadata
    // qb_sync_status='pending' and zero pipeline rows. That state blocks Force
    // Sync AND breaks any subsequent /customer-payments/:id/apply because
    // handlePosPaymentApplied can't resolve a source row (see Yeni 2498
    // incident 2026-05-23). The 'waiting' row is invisible to the consolidator
    // (only 'pending' is picked up) so SR semantics are preserved — the
    // invoice route transitions waiting→pending in Invoice mode or
    // skipPaymentRowByReference marks it skipped in SR mode.
    console.info(
      `[finance/payments] payment=${payment.id} skip_qb_sync=${skip_qb_sync} QB_ORDER_FLOW_ENABLED=${process.env.QB_ORDER_FLOW_ENABLED}`
    );
    if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
      const orderId: string | null = (metadata as any)?.order_id ?? null;
      try {
        await writePipelineRow({
          orderId,
          referenceId: payment.id,
          referenceType: "customer_payment",
          step: "payment",
          status: "waiting",
          medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
        });
      } catch (rowErr: any) {
        console.warn(
          `[finance/payments] Could not write upfront pipeline row: ${rowErr.message}`
        );
      }

      if (!skip_qb_sync) {
        // 1.5.9: pipeline-only — enqueue 'payment' for consolidator pickup.
        try {
          const {
            writePipelineRow: enqueueFinPay,
          } = require("../../../../lib/quickbooks/qb-pipeline");
          await enqueueFinPay({
            referenceId: payment.id,
            referenceType: "payment",
            step: "payment",
            status: "pending",
          });
        } catch (enqErr: any) {
          console.error(
            `[finance/payments] Enqueue payment failed: ${enqErr.message}`
          );
        }
      }
    }

    return res.json({ payment });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
