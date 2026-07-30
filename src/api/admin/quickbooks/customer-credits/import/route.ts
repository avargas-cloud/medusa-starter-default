import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { FINANCE_MODULE } from "../../../../../modules/finance";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../../../lib/pos/verify-supervisor-pin";
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

interface ExistingPaymentRow {
  id: string;
  status: string;
  display_id: number | null;
}

async function ensureDisplayId(
  client: Client,
  payment: ExistingPaymentRow
): Promise<number | null> {
  if (payment.display_id !== null) return payment.display_id;

  const { rows } = await client.query<{ display_id: number | null }>(
    `UPDATE customer_payment
        SET display_id = nextval('custom_payment_seq')
      WHERE id = $1 AND display_id IS NULL
      RETURNING display_id`,
    [payment.id]
  );
  return rows[0]?.display_id ?? null;
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
  // El PIN no se destructura: lo lee `extractSupervisorPin` (header primero, body
  // como fallback para no romper callers viejos).
  const { customer_id, txn_id, doc_type } = (req.body ?? {}) as ImportBody;

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
    // La comparación estaba copiada a mano acá porque el helper pedía knex y acá
    // hay un Client de pg; al copiarla se quedó sin límite de intentos, que es lo
    // único que separa "hay que saber el PIN" de "hay que adivinarlo" (4 dígitos =
    // 10.000 combinaciones). `pgAsPinConn` cierra esa brecha.
    //
    // Va ANTES del advisory lock a propósito: un caller no autorizado no debería
    // poder tomar el lock de un txn_id y serializar los imports legítimos.
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: pgAsPinConn(client),
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard);
      res.status(status).json(body);
      return;
    }

    // Serialize imports of the same QB document. The lock is released when this
    // dedicated connection closes, including error paths.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [txn_id]);

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
    const { rows: existing } = await client.query<ExistingPaymentRow>(
      `SELECT id, status, display_id FROM customer_payment
        WHERE metadata->>'qb_txn_id' = $1
          AND status <> 'voided'
          AND deleted_at IS NULL
        LIMIT 1`,
      [txn_id]
    );
    const existingRow = existing[0];
    if (existingRow) {
      const displayId = await ensureDisplayId(client, existingRow);
      res.json({
        success: true,
        already_imported: true,
        payment_id: existingRow.id,
        display_id: displayId,
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

    // A POS-created Credit Memo can be recreated in QB after a void and receive
    // a new TxnID. Its customer_payment may still carry the superseded TxnID.
    // Resolve the active TxnID through the confirmed pipeline row and repair the
    // existing store credit instead of minting a duplicate.
    if (doc_type === "credit_memo") {
      const { rows: linked } = await client.query<ExistingPaymentRow>(
        `SELECT cp.id, cp.status, cp.display_id
           FROM qb_order_pipeline q
           JOIN pos_credit_memo cm
             ON cm.id = q.reference_id
            AND cm.deleted_at IS NULL
           JOIN customer_payment cp
             ON cp.reference = cm.credit_memo_number
            AND cp.customer_id = $2
            AND cp.type = 'credit_memo'
            AND cp.status <> 'voided'
            AND cp.deleted_at IS NULL
          WHERE q.step = 'credit_memo'
            AND q.status = 'confirmed'
            AND q.qb_txn_id = $1
          ORDER BY q.confirmed_at DESC NULLS LAST, q.created_at DESC
          LIMIT 1`,
        [txn_id, customer_id]
      );
      const linkedRow = linked[0];
      if (linkedRow) {
        const displayId = await ensureDisplayId(client, linkedRow);
        await client.query(
          `UPDATE customer_payment
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                  qb = COALESCE(qb, '{}'::jsonb) || $3::jsonb,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            linkedRow.id,
            JSON.stringify({
              qb_txn_id: txn_id,
              qb_sync_status: "synced",
            }),
            JSON.stringify({ status: "yes", txn_id }),
          ]
        );
        res.json({
          success: true,
          already_imported: true,
          payment_id: linkedRow.id,
          display_id: displayId,
          amount_cents: amountCents,
          doc_type,
          repaired_stale_qb_link: true,
        });
        return;
      }
    }

    // ── Create the redeemable POS store-credit ──
    const financeService = req.scope.resolve(FINANCE_MODULE);
    const createdBy =
      ((req as any).auth_context?.actor_id as string | undefined) ?? "system";
    const { rows: sequenceRows } = await client.query<{ seq: string | number }>(
      `SELECT nextval('custom_payment_seq') AS seq`
    );
    const displayId = Number(sequenceRows[0]?.seq);
    const payment = await financeService.createCustomerPayments({
      customer_id,
      display_id: Number.isFinite(displayId) ? displayId : null,
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
      display_id: Number.isFinite(displayId) ? displayId : null,
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
