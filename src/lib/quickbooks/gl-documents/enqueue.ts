/**
 * enqueue.ts — mete un documento GL bancario en el `qb_order_pipeline`
 * (plan gl-docs-to-qb-20260914).
 *
 * Reusa `enqueuePurchaseQbOperation` con el documento como raíz de su propia
 * cadena (igual que `bill_payment_add`/`bill_payment_void`): el add y su
 * void quedan en serie, la `operation_key` (hash del payload) hace que
 * postear dos veces no encole dos veces, y el Retry / mark-fixed de la UI del
 * pipeline ya saben re-armar filas de esta forma.
 *
 * Se llama DENTRO de la transacción que postea el documento (los hooks viven
 * en `lib/ledger/documents/*` y `lib/banking/receipts-core.ts`, no en las
 * rutas): un documento posteado sin su fila de pipeline no existe. Cuando los
 * facts dicen "no listo" la fila igual se escribe — `failed` con el motivo si
 * es estructural, `skipped` si el documento no debe viajar, `pending` si sólo
 * falta que el pipeline confirme un cobro — porque una fila visible con un
 * motivo vale más que un `return` mudo (regla 2026-07-23).
 *
 * Void: exige que el documento tenga `qb_txn_id`. Si el ADD todavía no salió
 * (pending/waiting/failed) se marca `skipped` y no se encola nada — no hay
 * nada en QuickBooks que anular. Si el ADD está en vuelo (submitted /
 * processing) NO se encola acá: `enqueueGlDocumentVoidIfAlreadyVoided`
 * (confirm.ts) lo encola cuando el ADD confirme, leyendo el estado durable
 * del documento (regla 2026-07-29: la intención de void es el status del
 * documento, no una fila que nace sin TxnID).
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "../../purchase-orders/qb-purchase-dependency-chain";
import { isQbSyncEnabled } from "../sync-enabled";
import { buildTxnVoidQbxml } from "../txn-void-add";
import { loadGlDocumentAddFacts, loadGlDocumentQbLink } from "./facts";
import {
  GL_DOCUMENT_ADD_STEP,
  GL_DOCUMENT_VOID_STEP,
  type GlDocumentAddPayload,
  type GlDocumentKind,
  type GlDocumentVoidPayload,
} from "./types";

export type GlDocumentEnqueueResult =
  | { queued: true; pipelineRowId: string; status: "pending" | "waiting" | "failed" | "skipped" }
  | { queued: false; reason: string };

const LIVE_UNSENT = ["pending", "waiting", "failed"] as const;
const IN_FLIGHT = ["processing", "submitted"] as const;

async function findAddRow(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string,
  statuses: readonly string[]
): Promise<{ id: string; status: string } | null> {
  const result = await db.raw(
    `SELECT id, status FROM qb_order_pipeline
      WHERE step = ? AND reference_type = ? AND reference_id = ? AND status = ANY(?::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [GL_DOCUMENT_ADD_STEP, kind, documentId, [...statuses]]
  );
  return (result.rows[0] as { id: string; status: string } | undefined) ?? null;
}

async function findLiveVoidRow(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string,
  qbTxnId: string
): Promise<{ id: string } | null> {
  const result = await db.raw(
    `SELECT id FROM qb_order_pipeline
      WHERE step = ? AND reference_type = ? AND reference_id = ? AND qb_txn_id = ?
        AND status NOT IN ('failed', 'skipped')
      ORDER BY created_at DESC LIMIT 1`,
    [GL_DOCUMENT_VOID_STEP, kind, documentId, qbTxnId]
  );
  return (result.rows[0] as { id: string } | undefined) ?? null;
}

export async function enqueueGlDocumentAdd(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string
): Promise<GlDocumentEnqueueResult> {
  if (!isQbSyncEnabled()) return { queued: false, reason: "QB_SYNC_ENABLED=false" };

  const facts = await loadGlDocumentAddFacts(db, kind, documentId);
  const payload: GlDocumentAddPayload = facts.ready
    ? { kind, document_id: documentId, qb_txn_type: facts.qbTxnType, qbxml: facts.qbxml, ready: true }
    : {
        kind,
        document_id: documentId,
        qb_txn_type: null,
        qbxml: null,
        ready: false,
        reason: facts.reason,
        blocking_reference_ids: facts.blockingReferenceIds,
      };

  const operation = await enqueuePurchaseQbOperation(db, {
    purchaseOrderId: documentId,
    referenceId: documentId,
    referenceType: kind,
    step: GL_DOCUMENT_ADD_STEP,
    payload: payload as unknown as Record<string, unknown>,
    operationKey: purchaseOperationKey(GL_DOCUMENT_ADD_STEP, documentId, payload as unknown as Record<string, unknown>),
  });
  if (!operation) return { queued: false, reason: "QB_SYNC_ENABLED=false" };

  if (facts.ready || facts.blockingReferenceIds.length > 0) {
    // Listo, o transitorio: el despachador re-evalúa los facts y difiere solo.
    return { queued: true, pipelineRowId: operation.id, status: operation.status };
  }
  const terminal = facts.skip ? "skipped" : "failed";
  await db.raw(
    `UPDATE qb_order_pipeline
        SET status = ?, error = ?, failed_at = CASE WHEN ? = 'failed' THEN NOW() ELSE failed_at END, updated_at = NOW()
      WHERE id = ?::uuid AND status IN ('pending', 'waiting')`,
    [terminal, facts.reason, terminal, operation.id]
  );
  return { queued: true, pipelineRowId: operation.id, status: terminal };
}

export async function enqueueGlDocumentVoid(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string
): Promise<GlDocumentEnqueueResult> {
  if (!isQbSyncEnabled()) return { queued: false, reason: "QB_SYNC_ENABLED=false" };

  const link = await loadGlDocumentQbLink(db, kind, documentId);
  if (!link.exists) return { queued: false, reason: `${kind} not found` };

  if (!link.qb_txn_id || !link.qb_txn_type) {
    const unsent = await findAddRow(db, kind, documentId, LIVE_UNSENT);
    if (unsent) {
      await db.raw(
        `UPDATE qb_order_pipeline
            SET status = 'skipped', error = ?, updated_at = NOW()
          WHERE id = ?::uuid AND status = ANY(?::text[])`,
        ["document voided in the POS before its Add reached QuickBooks", unsent.id, [...LIVE_UNSENT]]
      );
      return { queued: false, reason: `add row ${unsent.id} skipped: the document never reached QuickBooks` };
    }
    const inFlight = await findAddRow(db, kind, documentId, IN_FLIGHT);
    if (inFlight) {
      return {
        queued: false,
        reason: `add row ${inFlight.id} is in flight (${inFlight.status}); the void is queued when it confirms`,
      };
    }
    return { queued: false, reason: "document has no QuickBooks TxnID: nothing to void" };
  }

  const existing = await findLiveVoidRow(db, kind, documentId, link.qb_txn_id);
  if (existing) return { queued: true, pipelineRowId: existing.id, status: "pending" };

  const payload: GlDocumentVoidPayload = {
    kind,
    document_id: documentId,
    qb_txn_type: link.qb_txn_type,
    qb_txn_id: link.qb_txn_id,
    qbxml: buildTxnVoidQbxml(link.qb_txn_type, link.qb_txn_id),
  };
  const operation = await enqueuePurchaseQbOperation(db, {
    purchaseOrderId: documentId,
    referenceId: documentId,
    referenceType: kind,
    step: GL_DOCUMENT_VOID_STEP,
    payload: payload as unknown as Record<string, unknown>,
    qbTxnId: link.qb_txn_id,
    operationKey: purchaseOperationKey(GL_DOCUMENT_VOID_STEP, documentId, payload as unknown as Record<string, unknown>),
  });
  if (!operation) return { queued: false, reason: "QB_SYNC_ENABLED=false" };
  return { queued: true, pipelineRowId: operation.id, status: operation.status };
}
