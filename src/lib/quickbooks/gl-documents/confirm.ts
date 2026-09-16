/**
 * confirm.ts — write-back al documento cuando QuickBooks confirma
 * (plan gl-docs-to-qb-20260914). Lo invoca `poll-submitted-rows.ts` desde la
 * rama de los steps `gl_document_add` / `gl_document_void`.
 *
 * ADD confirmado → `qb_txn_id`, `qb_txn_type`, `qb_edit_sequence`,
 * `qb_synced_at` en la tabla del documento. Y acto seguido la mitad que
 * costó la Invoice 21246 (regla 2026-07-29): si el documento YA está anulado
 * en el POS (se voideó mientras el ADD volaba), el void se encola ACÁ,
 * desde el estado durable del documento — nadie más lo va a reintentar.
 *
 * VOID confirmado → se limpian las columnas espejo. El TxnID anulado queda en
 * la fila del pipeline (y así lo sigue reconociendo el importador).
 */

import type { PurchaseDependencyKnex } from "../../purchase-orders/qb-purchase-dependency-chain";
import { enqueueGlDocumentVoid, type GlDocumentEnqueueResult } from "./enqueue";
import type { GlQbTxnType } from "./qbxml-builders";
import type { GlDocumentKind } from "./types";

export interface GlDocumentRet {
  TxnID?: string;
  EditSequence?: string;
}

/**
 * Status de un `<Tipo>Rs` que volvió por el passthrough raw. El bridge parsea
 * el QBXML con xml2js y deja los ATRIBUTOS bajo `$` — medido sobre
 * `qb_order_pipeline.qb_result` de un `vendor_credit_add` confirmado en prod
 * y sobre el sondeo del 2026-09-14 (`CheckQueryRs.$.statusCode`). Se acepta
 * también la forma plana por si el bridge alguna vez aplana los atributos.
 * Leer sólo la forma plana convierte cualquier rechazo (3120, 3000…) en
 * "statusCode null" y lo deja pasar como éxito.
 */
export function readDirectQueryStatus(rsNode: Record<string, unknown> | undefined): {
  statusCode: string | null;
  statusMessage: string;
} {
  if (!rsNode) return { statusCode: null, statusMessage: "" };
  const attrs = (rsNode.$ ?? {}) as Record<string, unknown>;
  const code = attrs.statusCode ?? rsNode.statusCode;
  const message = attrs.statusMessage ?? rsNode.statusMessage;
  return {
    statusCode: code != null ? String(code) : null,
    statusMessage: typeof message === "string" ? message : "",
  };
}

export async function handleGlDocumentAddConfirmed(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string,
  txnType: GlQbTxnType,
  ret: GlDocumentRet
): Promise<{ confirmed: true; voidQueued: GlDocumentEnqueueResult | null } | { confirmed: false; reason: string }> {
  if (!ret.TxnID) return { confirmed: false, reason: `${txnType}Ret has no TxnID` };
  await db.raw(
    `UPDATE ${kind}
        SET qb_txn_id = ?, qb_txn_type = ?, qb_edit_sequence = ?, qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [ret.TxnID, txnType, ret.EditSequence ?? null, documentId]
  );
  const voidQueued = (await isDocumentVoidedInPos(db, kind, documentId))
    ? await enqueueGlDocumentVoid(db, kind, documentId)
    : null;
  return { confirmed: true, voidQueued };
}

export async function handleGlDocumentVoidConfirmed(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string
): Promise<{ confirmed: true }> {
  await db.raw(
    `UPDATE ${kind}
        SET qb_txn_id = NULL, qb_txn_type = NULL, qb_edit_sequence = NULL, qb_synced_at = NULL, updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [documentId]
  );
  return { confirmed: true };
}

/**
 * La señal de intención de void es el ESTADO del documento, nunca una fila
 * del pipeline: gl_* → `status='voided'`; bank_deposit → `status='void'` o su
 * asiento de depósito reversado (la reversa contable es lo que anula el
 * depósito en el libro aunque el registro siga `ready`).
 */
export async function isDocumentVoidedInPos(
  db: PurchaseDependencyKnex,
  kind: GlDocumentKind,
  documentId: string
): Promise<boolean> {
  if (kind === "bank_deposit") {
    const result = await db.raw(
      `SELECT d.status,
              EXISTS (SELECT 1 FROM bank_journal_entry e
                       WHERE e.deleted_at IS NULL
                         -- record-deposits-gl (09/15): the posted deposit is a GL document
                         -- (source_kind/source_id, kind='document'); the legacy Banking
                         -- shape (deposit_id + kind='deposit') never existed in production.
                         -- Checking only the legacy shape read every real deposit as
                         -- "not posted" and TxnVoid'ed DEP-0685 one minute after its
                         -- DepositAdd confirmed (09/16/2026).
                         AND ((e.source_kind = 'bank_deposit' AND e.source_id = d.id AND e.kind = 'document')
                           OR (e.deposit_id = d.id AND e.kind = 'deposit'))
                         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)) AS posted
         FROM bank_deposit d WHERE d.id = ? AND d.deleted_at IS NULL`,
      [documentId]
    );
    const row = result.rows[0] as { status: string; posted: boolean } | undefined;
    if (!row) return false;
    return row.status === "void" || !row.posted;
  }
  const result = await db.raw(`SELECT status FROM ${kind} WHERE id = ? AND deleted_at IS NULL`, [documentId]);
  const row = result.rows[0] as { status: string } | undefined;
  return row?.status === "voided";
}
