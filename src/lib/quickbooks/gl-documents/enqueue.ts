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
import { SALES_SQL, WRITE } from "../pipeline-status";
import { buildTxnVoidQbxml } from "../txn-void-add";
import { loadGlDocumentAddFacts, loadGlDocumentQbLink } from "./facts";
import { loadGlDocumentModFacts, loadGlDocumentModLink } from "./facts-mod";
import {
  GL_DOCUMENT_ADD_STEP,
  GL_DOCUMENT_MOD_STEP,
  GL_DOCUMENT_VOID_STEP,
  type GlDocumentAddPayload,
  type GlDocumentKind,
  type GlDocumentModPayload,
  type GlDocumentVoidPayload,
} from "./types";

export type GlDocumentEnqueueResult =
  | {
      queued: true;
      pipelineRowId: string;
      status:
        | typeof WRITE.sales.dispatchable
        | typeof WRITE.sales.blocked
        | typeof WRITE.sales.failed
        | typeof WRITE.sales.skipped;
    }
  | { queued: false; reason: string };

const LIVE_UNSENT = [
  WRITE.sales.dispatchable,
  WRITE.sales.blocked,
  WRITE.sales.failed,
  WRITE.sales.error,
] as const;
const IN_FLIGHT = [WRITE.sales.processing, WRITE.sales.submitted] as const;

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
        AND status NOT IN (${SALES_SQL.notLive})
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
  const terminal = facts.skip ? WRITE.sales.skipped : WRITE.sales.failed;
  await db.raw(
    `UPDATE qb_order_pipeline
        SET status = ?, error = ?, failed_at = CASE WHEN ? = '${WRITE.sales.failed}' THEN NOW() ELSE failed_at END, updated_at = NOW()
      WHERE id = ?::uuid AND status IN (${SALES_SQL.dispatchable}, ${SALES_SQL.blocked})`,
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
            SET status = '${WRITE.sales.skipped}', error = ?, updated_at = NOW()
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
  if (existing) return { queued: true, pipelineRowId: existing.id, status: WRITE.sales.dispatchable };

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

/**
 * check-revise-20260918 — Mod de un documento corregido en el lugar.
 *
 * Tres estados del Add deciden qué se encola:
 *   · Add confirmado (hay TxnID, incluidos los adoptados) → fila `gl_document_mod`
 *     detrás del Add en la cadena del documento. Un segundo revise antes de que
 *     salga REESCRIBE esa fila (`COALESCIBLE_STEPS`), nunca apila dos viajes.
 *   · Add sin enviar (waiting/blocked/failed/error) → se marca `skipped`
 *     ("superseded by revision N") y se encola un Add NUEVO con los facts
 *     actuales: QuickBooks todavía no tiene el documento, así que lo que viaja
 *     es la versión corregida, no un Mod de algo que no existe.
 *   · Add en vuelo (processing/submitted) → fila `gl_document_mod` `blocked`
 *     detrás del Add; el despachador la difiere hasta que el Add confirme y
 *     escriba el TxnID (mismo trato que el void).
 * Estructural (tipo no modificable, cuenta `pos_`, vendor sin ListID) → fila
 * `failed` con motivo, visible en el pipeline.
 */
export async function enqueueGlDocumentMod(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string
): Promise<GlDocumentEnqueueResult> {
  if (!isQbSyncEnabled()) return { queued: false, reason: "QB_SYNC_ENABLED=false" };

  const link = await loadGlDocumentModLink(db, kind, documentId);
  if (!link.exists) return { queued: false, reason: `${kind} not found` };

  if (!link.qb_txn_id) {
    const unsent = await findAddRow(db, kind, documentId, LIVE_UNSENT);
    if (unsent) {
      await db.raw(
        `UPDATE qb_order_pipeline
            SET status = '${WRITE.sales.skipped}', error = ?, updated_at = NOW()
          WHERE id = ?::uuid AND status = ANY(?::text[])`,
        [`superseded by revision ${link.revision} before the Add reached QuickBooks`, unsent.id, [...LIVE_UNSENT]]
      );
      const fresh = await enqueueGlDocumentAdd(db, kind, documentId);
      // La cadena del documento encola el Add nuevo DETRÁS del que acabamos de
      // saltear, y el wake pass sólo libera a los que esperan un `synced`/`fixed`
      // (`SALES_SQL.done`): detrás de un `skipped` quedaría `blocked` para siempre.
      if (fresh.queued && fresh.status === WRITE.sales.blocked) {
        await db.raw(
          `UPDATE qb_order_pipeline w SET status = '${WRITE.sales.dispatchable}', updated_at = NOW()
             FROM qb_order_pipeline d
            WHERE w.id = ?::uuid AND w.status = '${WRITE.sales.blocked}' AND w.depends_on = d.id
              AND d.status = '${WRITE.sales.skipped}'`,
          [fresh.pipelineRowId]
        );
        return { ...fresh, status: WRITE.sales.dispatchable };
      }
      return fresh;
    }
    // Sin fila viva ni TxnID: o el Add está en vuelo (se encola el Mod detrás y el
    // despachador lo difiere), o el documento nunca viajó (facts lo dirán).
  }

  const reasonRow = await db.raw(`SELECT revision_reason FROM ${kind} WHERE id = ? AND deleted_at IS NULL`, [documentId]);
  const reason = ((reasonRow.rows[0] as { revision_reason?: string | null } | undefined)?.revision_reason ?? null);
  const payload: GlDocumentModPayload = {
    kind,
    document_id: documentId,
    qb_txn_type: link.qb_txn_type ?? "Check",
    qb_txn_id: link.qb_txn_id ?? "",
    revision: link.revision,
    reason,
  };
  const operation = await enqueuePurchaseQbOperation(db, {
    purchaseOrderId: documentId,
    referenceId: documentId,
    referenceType: kind,
    step: GL_DOCUMENT_MOD_STEP,
    payload: payload as unknown as Record<string, unknown>,
    qbTxnId: link.qb_txn_id ?? undefined,
    operationKey: purchaseOperationKey(GL_DOCUMENT_MOD_STEP, documentId, payload as unknown as Record<string, unknown>),
  });
  if (!operation) return { queued: false, reason: "QB_SYNC_ENABLED=false" };

  if (!link.qb_txn_id) {
    // Add en vuelo: la fila espera su TxnID. Los facts se evalúan al despachar.
    return { queued: true, pipelineRowId: operation.id, status: operation.status };
  }
  // Con TxnID se evalúan YA los facts estructurales (con el EditSequence conocido,
  // sólo para armar; el despachador vuelve a leer uno fresco).
  const facts = await loadGlDocumentModFacts(db, kind, documentId, link.qb_edit_sequence ?? "0");
  if (facts.ready) return { queued: true, pipelineRowId: operation.id, status: operation.status };
  await db.raw(
    `UPDATE qb_order_pipeline
        SET status = '${WRITE.sales.failed}', error = ?, failed_at = NOW(), updated_at = NOW()
      WHERE id = ?::uuid AND status IN (${SALES_SQL.dispatchable}, ${SALES_SQL.blocked})`,
    [facts.reason, operation.id]
  );
  return { queued: true, pipelineRowId: operation.id, status: WRITE.sales.failed };
}
