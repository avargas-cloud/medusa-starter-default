/**
 * facts-mod.ts — "¿está listo el Mod y cómo se ve?" de un documento GL
 * corregido en el lugar (plan check-revise-20260918). Hoy sólo `gl_check`.
 *
 * Se evalúa en DOS momentos, como los facts del Add: al encolar (para dejar
 * una fila `failed` con motivo si es estructural) y al despachar, con el
 * `editSequence` FRESCO que el despachador acaba de leer de QuickBooks —
 * nunca se confía en el que quedó en la tabla al confirmar el Add.
 */

import { toQbRefNumber } from "../qb-ref-number";
import { one, type GlDocumentDb } from "./facts-shared";
import { resolveCheckQbShape } from "./facts";
import type { GlQbTxnType } from "./qbxml-builders";
import {
  GL_MOD_CAPABLE_TXN_TYPES,
  buildCheckModQbxml,
  buildCreditCardChargeModQbxml,
} from "./qbxml-mod-builders";
import type { GlDocumentKind } from "./types";

export type GlDocumentModFacts =
  | { ready: true; qbxml: string; qbTxnType: GlQbTxnType; qbTxnId: string }
  | { ready: false; reason: string };

const notReady = (reason: string): GlDocumentModFacts => ({ ready: false, reason });

/** TxnID/tipo/EditSequence vivos + revision del documento (para el enqueue y el guard de superseded). */
export async function loadGlDocumentModLink(
  db: GlDocumentDb,
  kind: GlDocumentKind,
  documentId: string
): Promise<{
  exists: boolean;
  status: string | null;
  qb_txn_id: string | null;
  qb_txn_type: GlQbTxnType | null;
  qb_edit_sequence: string | null;
  revision: number;
}> {
  if (kind !== "gl_check")
    return { exists: false, status: null, qb_txn_id: null, qb_txn_type: null, qb_edit_sequence: null, revision: 0 };
  const row = one<{
    status: string;
    qb_txn_id: string | null;
    qb_txn_type: GlQbTxnType | null;
    qb_edit_sequence: string | null;
    revision: number;
  }>(
    await db.raw(
      `SELECT status, qb_txn_id, qb_txn_type, qb_edit_sequence, revision FROM gl_check WHERE id = ? AND deleted_at IS NULL`,
      [documentId]
    )
  );
  if (!row) return { exists: false, status: null, qb_txn_id: null, qb_txn_type: null, qb_edit_sequence: null, revision: 0 };
  return { exists: true, ...row, revision: Number(row.revision) };
}

/**
 * Arma el `<Tipo>ModRq` con el EditSequence dado. Estructural (`ready:false`)
 * cuando el documento no vive en QuickBooks, cuando su tipo QB no admite Mod
 * o no coincide con la forma actual (un Check no se vuelve CreditCardCharge —
 * el revise ya lo rechaza upstream; acá es el cinturón), o cuando la forma no
 * se puede resolver (cuenta `pos_`, vendor sin ListID…).
 */
export async function loadGlDocumentModFacts(
  db: GlDocumentDb,
  kind: GlDocumentKind,
  documentId: string,
  editSequence: string
): Promise<GlDocumentModFacts> {
  if (kind !== "gl_check") return notReady(`${kind} does not support in-place revision (void + new document)`);
  if (!editSequence) return notReady("EditSequence is required to build a Mod");
  const shape = await resolveCheckQbShape(db, documentId);
  if (!shape.ok) return notReady(shape.reason);
  const { doc, isCard, payeeListId, memo, expenseLines } = shape;
  if (!doc.qb_txn_id) return notReady("document has no QuickBooks TxnID yet");
  const link = await loadGlDocumentModLink(db, kind, documentId);
  const expectedType: GlQbTxnType = isCard ? "CreditCardCharge" : "Check";
  if (!link.qb_txn_type || !GL_MOD_CAPABLE_TXN_TYPES.includes(link.qb_txn_type))
    return notReady(`QuickBooks type '${link.qb_txn_type ?? "?"}' cannot be modified in place`);
  if (link.qb_txn_type !== expectedType)
    return notReady(`revise_type_change: QuickBooks holds a ${link.qb_txn_type}, the document is now a ${expectedType}`);

  try {
    const common = {
      txnId: doc.qb_txn_id,
      editSequence,
      bankAccountListId: doc.bank_account_list_id,
      payeeListId,
      txnDate: doc.day,
      refNumber: toQbRefNumber(doc.number),
      memo,
      lines: expenseLines,
    };
    const qbxml = isCard
      ? buildCreditCardChargeModQbxml(common)
      : buildCheckModQbxml({ ...common, isToBePrinted: doc.to_be_printed === true });
    return { ready: true, qbxml, qbTxnType: expectedType, qbTxnId: doc.qb_txn_id };
  } catch (error) {
    return notReady(error instanceof Error ? error.message : "could not build the check Mod QBXML");
  }
}
