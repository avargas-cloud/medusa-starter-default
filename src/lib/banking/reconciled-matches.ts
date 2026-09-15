import type { PoolClient } from "pg";

import {
  docLabelFor,
  glCheckJoinSql,
  PAYEE_JOIN_SQL,
  payeeColumnSql,
  RESOLVED_DOC_NUMBER_SQL,
} from "../ledger/reports/doc-labels";

/**
 * Filas Reconciled del Bank Feed → los asientos del libro con los que casaron.
 *
 * Una línea del feed que pertenece a un extracto CERRADO se casó por extracto
 * (`bank_statement_match` → `bank_journal_line` → `bank_journal_entry`), no por el
 * flujo de review, así que la pantalla no tenía nada que mostrar en From/To ni en
 * Match/Category (2026-09-15). Esto es SÓLO LECTURA: cuelga `reconciled.matches`
 * en la proyección; la identidad completa (`match_id`, `statement_line_id`) viaja
 * ya para el futuro "Corregir", que hoy no existe.
 *
 * Una línea del banco puede casar con VARIOS asientos y de ambos signos (casamiento
 * neto: un depósito de tarjeta = depósitos − reembolsos). `amount_cents` es la
 * PORCIÓN aplicada por el match (hay matches parciales), con el signo de la línea
 * contable — débito de Bank / de CreditCard = positivo — que coincide con el signo
 * del feed (`-t.amount`) en ambos tipos de cuenta.
 */
export interface ReconciledMatch {
  match_id: string;
  statement_line_id: string;
  line_id: string;
  entry_id: string;
  day: string;
  source_kind: string | null;
  source_id: string | null;
  document_number: string | null;
  doc_label: string;
  payee_name: string | null;
  memo: string | null;
  amount_cents: number;
  is_reversal: boolean;
  is_reversed: boolean;
}

/** Fila cruda del SQL: `amount_cents` puede llegar como texto (bigint). */
export type ReconciledMatchRow = Omit<ReconciledMatch, "doc_label"> & {
  transaction_id: string;
};

/**
 * Misma resolución de número y contraparte que el register de cuentas
 * (`lib/ledger/reports/doc-labels`): `gl_check.payee_name` se joinea estático
 * porque la migración `GlManualDocuments` ya es ancestro de master.
 */
export const RECONCILED_MATCHES_SQL = `SELECT m.id AS match_id,sl.transaction_id,m.statement_line_id,
    l.id AS line_id,e.id AS entry_id,e.day,e.source_kind,e.source_id,
    ${RESOLVED_DOC_NUMBER_SQL} AS document_number,
    ${payeeColumnSql("payee_name")} AS payee_name,
    NULLIF(TRIM(e.description),'') AS memo,
    (SIGN(l.debit_cents-l.credit_cents)*m.amount_cents)::float8 AS amount_cents,
    (e.reverses_entry_id IS NOT NULL) AS is_reversal,
    EXISTS(SELECT 1 FROM bank_journal_entry rv WHERE rv.reverses_entry_id=e.id AND rv.deleted_at IS NULL) AS is_reversed
  FROM bank_statement_match m
  JOIN bank_statement_line sl ON sl.id=m.statement_line_id AND sl.deleted_at IS NULL
  JOIN bank_journal_line l ON l.id=m.book_id AND l.deleted_at IS NULL
  JOIN bank_journal_entry e ON e.id=l.entry_id AND e.deleted_at IS NULL
  ${PAYEE_JOIN_SQL}${glCheckJoinSql("payee_name")}
  WHERE sl.transaction_id=ANY($1::text[]) AND m.deleted_at IS NULL AND m.book_kind='journal_line'
  ORDER BY e.day,e.id,m.id`;

type ReconciledRef = {
  statement_id: string;
  from_day: string;
  to_day: string;
};

/**
 * The page row after the post-pass: `reconciled` carries `matches` when it is
 * set. An intersection (not an Omit) so the result still IS the caller's row
 * type — `BankTransactionView` keeps its required `reconciled: … | null`.
 */
export type WithReconciledMatches<T> = T & {
  reconciled?: (ReconciledRef & { matches: ReconciledMatch[] }) | null;
};

/**
 * Post-pass sobre la página (mismo patrón que `journalClaimProjection`): una
 * query con los ids reconciled, reparto por transacción. Las filas sin
 * `reconciled` salen intactas; sin ninguna reconciled no se consulta nada.
 */
export async function reconciledMatchesProjection<
  T extends { id: string; reconciled?: ReconciledRef | null },
>(
  client: Pick<PoolClient, "query">,
  rows: T[]
): Promise<Array<WithReconciledMatches<T>>> {
  const ids = rows.filter((row) => row.reconciled).map((row) => row.id);
  // A row without `reconciled` (null/undefined) already satisfies the output shape.
  if (ids.length === 0) return rows as Array<WithReconciledMatches<T>>;
  const matched = (await client.query<ReconciledMatchRow>(RECONCILED_MATCHES_SQL, [ids])).rows;
  const byTransaction = new Map<string, ReconciledMatch[]>();
  for (const row of matched) {
    const list = byTransaction.get(row.transaction_id) ?? [];
    byTransaction.set(row.transaction_id, [
      ...list,
      {
        match_id: row.match_id,
        statement_line_id: row.statement_line_id,
        line_id: row.line_id,
        entry_id: row.entry_id,
        day: row.day,
        source_kind: row.source_kind,
        source_id: row.source_id,
        document_number: row.document_number,
        doc_label: docLabelFor(row.source_kind, row.document_number),
        payee_name: row.payee_name,
        memo: row.memo,
        amount_cents: Number(row.amount_cents),
        is_reversal: row.is_reversal,
        is_reversed: row.is_reversed,
      },
    ]);
  }
  return rows.map((row) =>
    row.reconciled
      ? {
          ...row,
          reconciled: {
            ...row.reconciled,
            matches: byTransaction.get(row.id) ?? [],
          },
        }
      : (row as WithReconciledMatches<T>)
  );
}
