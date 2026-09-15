/**
 * qb-gl-import — qué documentos de QuickBooks CONOCE el POS y POSTEA el libro
 * (docs/QB_GL_IMPORT.md §2).
 *
 * Medido el 2026-09-11 (14/04→20/05): del lado "tipos que el POS produce",
 * después del corte el POS conocía 335 de 340 Sales Receipts, 94 de 107
 * Invoices, 72 de 80 Payments, 34 de 65 Bills… y 0 de 10 Bill Pmt -Check,
 * 0 de 14 vendor credits. Omitir por TIPO dejaba fuera del libro cada
 * documento que se hizo directo en QB (los pagos de bills de todo el año,
 * para empezar) y la paridad de bancos/AP no cerraba. Y al revés: un tipo
 * "bancario" también puede venir del POS (cheque de refund, cheque de
 * comisión) — importarlo duplica.
 *
 * La regla correcta es por IDENTIDAD: después del corte, un documento de QB
 * se omite si su TxnID está enlazado a un documento del POS **que el libro
 * postea** (`replay.ts` ALL_KINDS: invoices, credit memos, cobros/refunds,
 * recepciones, bills, vendor credits, pagos de bills). Lo demás entra desde QB.
 *
 * Deliberadamente FUERA de la unión (el libro NO los postea, así que su
 * documento de QB es la única fuente): `inventory_adjustment` y
 * `cm_damage_adjustment` (ajustes de inventario), `commission_check` /
 * `commission_payment` (el GL no postea comisiones; el cheque de QB entra
 * desde QB), los `void_*`, y los no-posting (estimate, sales_order, customer,
 * purchase_order_mod).
 *
 * Agregar una tabla de enlace nueva es agregar un `UNION` acá.
 */
import type { PoolClient } from "pg";

/** Steps de `qb_order_pipeline` cuyo documento del POS postea el libro. */
export const GL_POSTED_PIPELINE_STEPS = [
  "invoice",
  "invoice_update",
  "sales_receipt",
  "sales_receipt_update",
  "credit_memo",
  "credit_memo_mod",
  "payment",
  "apply_payment",
  "payment_method_change",
  "payment_txndate_change",
  "refund_payment",
  "refund_check_mod",
  "refund_payment_txndate_change",
  "item_receipt_add",
  "item_receipt_mod",
  "vendor_bill_add",
  "vendor_bill_mod",
  "vendor_bill_payment_check",
  // gl-docs-to-qb-20260914: cheques/gastos, transfers, asientos manuales y
  // depósitos del POS. Un "tipo bancario" (Check, Deposit, General Journal,
  // Credit Card Charge) que el POS escribió en QuickBooks NO se importa de
  // vuelta: su TxnID vive en la fila del pipeline (historial, anulados
  // incluidos) y en la columna espejo de su tabla (vivos).
  "gl_document_add",
  "gl_document_void",
] as const;

const KNOWN_TXN_ID_SQL = `
  SELECT DISTINCT t FROM (
    SELECT qb_txn_id t FROM qb_order_pipeline WHERE step = ANY($1::text[])
    UNION SELECT qb_txn_id FROM vendor_bill
    UNION SELECT qb_txn_id FROM vendor_bill_payment
    UNION SELECT qb_txn_id FROM vendor_credit
    UNION SELECT qb_txn_id FROM qb_vendor_bill_pipeline
    UNION SELECT qb_txn_id FROM pos_credit_memo
    UNION SELECT qb_item_receipt_list_id FROM purchase_order_receipt
    UNION SELECT qb_list_id FROM qb_item_receipt_pipeline
    UNION SELECT qb_txn_id FROM qb_legacy_payment
    UNION SELECT qb_txn_id FROM qb_legacy_so
    UNION SELECT qb_txn_id FROM gl_check
    UNION SELECT qb_txn_id FROM gl_transfer
    UNION SELECT qb_txn_id FROM gl_journal_entry
    UNION SELECT qb_txn_id FROM bank_deposit
  ) u WHERE t IS NOT NULL AND t <> ''`;

/** TxnIDs de QuickBooks enlazados a documentos del POS que el libro postea. */
export async function loadPosKnownTxnIds(client: PoolClient): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ t: string }>(KNOWN_TXN_ID_SQL, [[...GL_POSTED_PIPELINE_STEPS]]);
  return new Set(rows.map((r) => r.t));
}

/**
 * adopt-qb-bank-documents-20260915: TxnIDs cuyo asiento del libro YA es de un
 * documento GL del POS (`gl_check` / `gl_transfer` vivos con `entry_id`):
 * adoptados desde QuickBooks o nativos. Después de la adopción el asiento deja
 * de ser `qb_import`, así que `postDocumentJournal` no lo frenaría con
 * `already_posted`: el importador los omite en CUALQUIER fecha
 * (`classify(..., postedByPos)`).
 */
export async function loadPosPostedTxnIds(client: PoolClient): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ t: string }>(
    `SELECT qb_txn_id AS t FROM gl_check WHERE qb_txn_id IS NOT NULL AND entry_id IS NOT NULL AND deleted_at IS NULL
     UNION SELECT qb_txn_id FROM gl_transfer WHERE qb_txn_id IS NOT NULL AND entry_id IS NOT NULL AND deleted_at IS NULL`
  );
  return new Set(rows.map((r) => r.t));
}
