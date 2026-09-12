/**
 * qb-gl-import — tipos del importador del reporte General Ledger de
 * QuickBooks al libro (`bank_journal_entry` familia `document`,
 * `source_kind = 'qb_import'`, `source_id = TxnID`).
 *
 * Diseño: docs/QB_GL_IMPORT.md. Nada acá toca la DB ni el bridge.
 */

export type QbClearedStatus = "Cleared" | "NotCleared" | "Pending";

/** Una fila del reporte, ya normalizada: UNA línea contable de UN documento. */
export interface QbGlRow {
  /** FullName de la cuenta (sección `RowData rowType=account` del reporte). */
  account: string;
  /** `TxnType` tal cual lo imprime QuickBooks ("Check", "Sales Receipt", "Bill Pmt -Check"…). */
  txn_type: string;
  /** Las líneas de inventario/COGS que QB deriva de los ítems de una venta vienen SIN TxnID. */
  txn_id: string | null;
  /** YYYY-MM-DD (fecha de negocio de QB). */
  date: string;
  ref_number: string | null;
  name: string | null;
  memo: string | null;
  split_account: string | null;
  cleared_status: QbClearedStatus | null;
  debit_cents: bigint;
  credit_cents: bigint;
}

/**
 * `SubtotalRow` del reporte: total débitos/créditos de una cuenta en la ventana.
 * Una cuenta padre con movimientos propios imprime DOS subtotales con el mismo
 * `RowData` (medido 2026-09-11, ventana 01-29..02-04): "Total X - Other"
 * (sólo sus filas directas, `scope = direct`) y "Total X" (ella + sus
 * subcuentas, `scope = subtree`).
 */
export interface QbGlAccountTotal {
  account: string;
  scope: "direct" | "subtree";
  debit_cents: bigint;
  credit_cents: bigint;
}

export interface QbGlReport {
  from: string;
  to: string;
  /** `NumRows` que declara QB — para detectar respuestas truncadas. */
  num_rows: number;
  rows: QbGlRow[];
  totals: QbGlAccountTotal[];
}

/**
 * Política por tipo de documento (docs/QB_GL_IMPORT.md §2):
 * - `pos_owned`: el POS postea este tipo desde `GL_REPLAY_FROM`; de QB entra
 *   sólo hasta el corte (`POS_CUTOFF_DAY`).
 * - `bank_side`: el POS no produce este tipo; de QB entra todo el rango.
 */
export type ImportPolicy = "pos_owned" | "bank_side";

export type ClassifyDecision =
  /** `qb_only`: tipo del POS después del corte que el POS NO sincronizó (se hizo directo en QB) → entra desde QB. */
  | { action: "import"; policy: ImportPolicy; qb_only?: boolean }
  /** Después del corte el POS ya lo postea (TxnID enlazado): vale para cualquier política. */
  | { action: "skip_pos_owned_after_cutoff"; policy: ImportPolicy }
  | { action: "blocked_unknown_type" };

/** Un documento de QB reconstruido a partir de sus filas. */
export interface QbGlDocument {
  txn_id: string;
  txn_type: string;
  date: string;
  ref_number: string | null;
  name: string | null;
  rows: QbGlRow[];
}

export interface BlockedDocument {
  /** `txn_id`, o la clave (tipo|fecha|número|nombre) cuando no hay TxnID. */
  key: string;
  txn_type: string;
  date: string;
  reason:
    | "orphan_rows_without_txn_id"
    | "ambiguous_rows_without_txn_id"
    | "unbalanced"
    | "line_count_out_of_range"
    | "unknown_account"
    | "unknown_type";
  detail?: string;
  rows: number;
}

export interface AssembleResult {
  documents: QbGlDocument[];
  blocked: BlockedDocument[];
  /** Filas con débito y crédito en cero (documentos voideados): se descartan. */
  dropped_zero_rows: number;
  /** Documentos cuyas filas eran TODAS cero (voideados): no se postean ni se bloquean. */
  skipped_zero_documents: number;
}

/** Snapshot que viaja en `bank_journal_entry.source_snapshot` — todo serializable. */
export interface QbImportSnapshot {
  txn_id: string;
  txn_type: string;
  date: string;
  ref_number: string | null;
  name: string | null;
  policy: ImportPolicy;
  rows: Array<{
    account: string;
    account_list_id: string;
    memo: string | null;
    split_account: string | null;
    cleared_status: QbClearedStatus | null;
    debit_cents: string;
    credit_cents: string;
  }>;
}
