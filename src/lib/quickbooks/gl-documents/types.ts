/**
 * types.ts — vocabulario del carril "documentos GL bancarios → QuickBooks"
 * (plan gl-docs-to-qb-20260914).
 *
 * DOS steps genéricos en `qb_order_pipeline` en vez de ocho: el documento se
 * distingue por `reference_type` (una de las cuatro tablas) y el tipo QB que
 * se creó viaja en `payload.qb_txn_type` — que es lo único que el poller y el
 * TxnVoid necesitan para parsear `<Tipo>AddRs` y nombrar `<TxnVoidType>`.
 */

import type { GlQbTxnType } from "./qbxml-builders";

export const GL_DOCUMENT_ADD_STEP = "gl_document_add" as const;
export const GL_DOCUMENT_VOID_STEP = "gl_document_void" as const;
export type GlDocumentStep = typeof GL_DOCUMENT_ADD_STEP | typeof GL_DOCUMENT_VOID_STEP;

/** `reference_type` de la fila del pipeline = la TABLA del documento. */
export const GL_DOCUMENT_KINDS = [
  "gl_check",
  "gl_transfer",
  "gl_journal_entry",
  "bank_deposit",
] as const;
export type GlDocumentKind = (typeof GL_DOCUMENT_KINDS)[number];

export const isGlDocumentKind = (value: unknown): value is GlDocumentKind =>
  typeof value === "string" && (GL_DOCUMENT_KINDS as readonly string[]).includes(value);

/** Lo que viaja en `payload` de una fila `gl_document_add`. */
export interface GlDocumentAddPayload {
  kind: GlDocumentKind;
  document_id: string;
  qb_txn_type: GlQbTxnType | null;
  qbxml: string | null;
  ready: boolean;
  /** Motivo cuando `ready=false` (estructural o transitorio). */
  reason?: string;
  /** Ids del POS cuyo TxnID de QB falta todavía (transitorio: se re-chequea al despachar). */
  blocking_reference_ids?: string[];
}

/** Lo que viaja en `payload` de una fila `gl_document_void`. */
export interface GlDocumentVoidPayload {
  kind: GlDocumentKind;
  document_id: string;
  qb_txn_type: GlQbTxnType;
  qb_txn_id: string;
  qbxml: string;
}

/** Columnas espejo que la migración `GlDocumentsQbLink` agregó a las 4 tablas. */
export interface GlDocumentQbLink {
  qb_txn_id: string | null;
  qb_txn_type: GlQbTxnType | null;
  qb_edit_sequence: string | null;
  qb_synced_at: string | null;
}
