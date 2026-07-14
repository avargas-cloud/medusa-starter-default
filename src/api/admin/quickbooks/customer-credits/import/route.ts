import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { FINANCE_MODULE } from "../../../../../modules/finance";
import {
  buildCreditMemoQuery,
  buildReceivePaymentQuery,
  parseCreditMemos,
  parsePayments,
  runDirectQuery,
  type QbCreditDocType,
} from "../_lib/qb-credit-query";

interface ImportBody {
  customer_id?: string;
  txn_id?: string;
  doc_type?: QbCreditDocType;
  supervisor_pin?: string;
}

/**
 * POST /admin/quickbooks/customer-credits/import
 *
 * Imports an EXISTING QuickBooks credit (credit memo or unapplied payment) into
 * the POS as a redeemable store-credit. It creates a `customer_payment` that
 * POINTS at the existing QB TxnID (metadata.qb_txn_id) with status='available'
 * — it does NOT mint a new QB document. When later applied to an invoice, the
 * apply_payment handler applies the SAME existing QB doc (routes on `type`,
 * resolves the doc from metadata.qb_txn_id). See project_qb_only_credit_redemption.
 *
 * Body: { customer_id, txn_id, doc_type, supervisor_pin }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { customer_id, txn_id, doc_type, supervisor_pin } = (req.body ??
    {}) as ImportBody;

  if (!customer_id || !txn_id || !doc_type) {
    res
      .status(400)
      .json({ error: "customer_id, txn_id and doc_type are required" });
    return;
  }
  if (doc_type !== "credit_memo" && doc_type !== "payment") {
    res.status(400).json({ error: "doc_type must be credit_memo or payment" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // ── Supervisor PIN (defense in depth — the frontend gate is not enough) ──
    const { rows: storeRows } = await client.query<{
      metadata: Record<string, any> | null;
    }>(
      `SELECT metadata FROM store
        WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    );
    const storedPin = storeRows[0]?.metadata?.pos_supervisor_pin as
      | string
      | undefined;
    if (!storedPin || String(supervisor_pin ?? "") !== String(storedPin)) {
      res.status(403).json({ error: "Invalid supervisor PIN" });
      return;
    }

    // ── Resolve customer + its QB ListID ──
    const { rows: custRows } = await client.query<{
      qb_list_id: string | null;
    }>(
      `SELECT metadata->>'qb_list_id' AS qb_list_id FROM customer WHERE id = $1`,
      [customer_id]
    );
    if (custRows.length === 0) {
      res.status(404).json({ error: `Customer ${customer_id} not found` });
      return;
    }
    const qbListId = custRows[0]?.qb_list_id ?? null;
    if (!qbListId) {
      res
        .status(400)
        .json({ error: "Customer is not linked to a QuickBooks account" });
      return;
    }

    // ── Idempotency: already imported? ──
    const { rows: existing } = await client.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status FROM customer_payment
        WHERE metadata->>'qb_txn_id' = $1 AND status <> 'voided' LIMIT 1`,
      [txn_id]
    );
    const existingRow = existing[0];
    if (existingRow) {
      res.json({
        success: true,
        already_imported: true,
        payment_id: existingRow.id,
      });
      return;
    }

    // ── Re-query QB for THIS doc (authoritative amount + customer match) ──
    const raw = await runDirectQuery(
      doc_type === "credit_memo"
        ? buildCreditMemoQuery({ txnId: txn_id })
        : buildReceivePaymentQuery({ txnId: txn_id })
    );
    const parsed =
      doc_type === "credit_memo" ? parseCreditMemos(raw) : parsePayments(raw);
    const doc = parsed.find((c) => c.txn_id === txn_id);
    if (!doc) {
      res.status(404).json({
        error: "QB document not found or has no remaining credit to import",
      });
      return;
    }
    if (doc.customer_list_id && doc.customer_list_id !== qbListId) {
      res.status(409).json({
        error: "QB document belongs to a different customer than selected",
      });
      return;
    }

    const amountCents = Math.round(doc.remaining * 100);
    if (amountCents <= 0) {
      res.status(400).json({ error: "QB document has no remaining credit" });
      return;
    }

    // ── Create the redeemable POS store-credit ──
    const financeService = req.scope.resolve(FINANCE_MODULE);
    const createdBy =
      ((req as any).auth_context?.actor_id as string | undefined) ?? "system";
    const payment = await financeService.createCustomerPayments({
      customer_id,
      amount: amountCents,
      method: doc_type === "credit_memo" ? "credit_memo" : "other",
      reference: doc.ref_number || null,
      notes: "Imported from QuickBooks",
      received_at: doc.txn_date ? new Date(doc.txn_date) : new Date(),
      created_by: createdBy,
      source: "pos",
      type: doc_type === "credit_memo" ? "credit_memo" : "payment",
      status: "available",
      metadata: {
        qb_import: true,
        qb_txn_id: txn_id,
        qb_doc_type: doc_type,
      },
    });

    // Parity with the legacy-payment importer: stamp the qb column so the doc
    // shows as QB-synced in the UI (the apply handler reads metadata, not this).
    await client.query(
      `UPDATE customer_payment SET qb = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ status: "yes", txn_id }), payment.id]
    );

    res.json({
      success: true,
      already_imported: false,
      payment_id: payment.id,
      amount_cents: amountCents,
      doc_type,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to import QB credit";
    console.error(`[QB Import Credit ${txn_id}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
