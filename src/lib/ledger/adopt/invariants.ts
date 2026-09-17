/**
 * adopt-qb-bank-documents — invariantes de lectura que valen en el clon y en
 * producción, después de adoptar (las comparten el E2E y `verify-adopt-qb-bank-documents`):
 *
 *   a. la migración está: `bank_journal_immutable()` llama a `bank_journal_reparent_allowed`
 *      y `gl_check`/`gl_transfer` tienen `qb_source`;
 *   b. todo adoptado vivo es dueño de su asiento (source_kind/source_id/document_number),
 *      está `posted`, y su total = lo que el banco acreditó (= Σ de sus líneas en gl_check);
 *   c. ningún `qb_import` ACTIVO comparte TxnID con un documento vivo (no doble conteo);
 *   d. una fila `gl_document_add` `confirmed` adoptada por documento;
 *   e. las series CHK-/TR- no tienen huecos ni duplicados, son cronológicas por
 *      (día, created_at del asiento) y el contador está en el máximo; sin `tmp:`.
 */
import type { PoolClient } from "pg";
import { SALES_SQL } from "../../quickbooks/pipeline-status";

export interface AdoptionInvariants {
  checks: number;
  transfers: number;
  failures: string[];
}

async function one<T>(client: PoolClient, sql: string): Promise<T> {
  return (await client.query(sql)).rows[0] as T;
}

export async function checkAdoptionInvariants(client: PoolClient): Promise<AdoptionInvariants> {
  const failures: string[] = [];
  const schema = await one<{ guard: boolean; cols: string }>(client, `
    SELECT position('bank_journal_reparent_allowed' in pg_get_functiondef('bank_journal_immutable'::regproc)) > 0 AS guard,
           (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('gl_check','gl_transfer') AND column_name='qb_source')::text AS cols`);
  if (!schema.guard) failures.push("a. bank_journal_immutable() sin la arista de re-parent (migración GlAdoptQbImport ausente)");
  if (schema.cols !== "2") failures.push(`a. columna qb_source presente en ${schema.cols}/2 tablas`);
  if (failures.length) return { checks: 0, transfers: 0, failures };

  const bad = await one<{ n: string; sample: string | null }>(client, `
    WITH bad AS (
      SELECT c.doc_number FROM gl_check c JOIN bank_journal_entry e ON e.id=c.entry_id
       WHERE c.qb_source='adopted' AND c.deleted_at IS NULL AND c.status='posted'
         AND NOT (e.source_kind='bank_check' AND e.source_id=c.id AND e.document_number=c.doc_number
                  AND c.total_cents = (SELECT sum(l.credit_cents-l.debit_cents) FROM bank_journal_line l WHERE l.entry_id=e.id AND l.account_list_id=c.bank_account_list_id)
                  AND c.total_cents = (SELECT sum(amount_cents) FROM gl_check_line WHERE check_id=c.id))
      UNION ALL
      SELECT t.doc_number FROM gl_transfer t JOIN bank_journal_entry e ON e.id=t.entry_id
       WHERE t.qb_source='adopted' AND t.deleted_at IS NULL AND t.status='posted'
         AND NOT (e.source_kind='bank_transfer' AND e.source_id=t.id AND e.document_number=t.doc_number
                  AND t.amount_cents = (SELECT sum(l.credit_cents-l.debit_cents) FROM bank_journal_line l WHERE l.entry_id=e.id AND l.account_list_id=t.from_account_list_id))
    ) SELECT count(*)::text AS n, min(doc_number) AS sample FROM bad`);
  if (bad.n !== "0") failures.push(`b. ${bad.n} adoptados no son dueños de su asiento o su total ≠ crédito bancario (p. ej. ${bad.sample})`);

  const counts = await one<{ checks: string; transfers: string; rows: string; twins: string }>(client, `
    SELECT (SELECT count(*) FROM gl_check WHERE qb_source='adopted' AND deleted_at IS NULL)::text AS checks,
           (SELECT count(*) FROM gl_transfer WHERE qb_source='adopted' AND deleted_at IS NULL)::text AS transfers,
           (SELECT count(*) FROM qb_order_pipeline p WHERE p.step='gl_document_add' AND p.status IN (${SALES_SQL.synced}) AND p.qb_result->>'adopted'='true'
              AND EXISTS (SELECT 1 FROM gl_check c WHERE c.id=p.reference_id AND c.deleted_at IS NULL UNION SELECT 1 FROM gl_transfer t WHERE t.id=p.reference_id AND t.deleted_at IS NULL))::text AS rows,
           (SELECT count(*) FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' AND e.day>='2026-01-01'
              AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)
              AND e.source_id IN (SELECT qb_txn_id FROM gl_check WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL
                                  UNION SELECT qb_txn_id FROM gl_transfer WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL))::text AS twins`);
  if (counts.twins !== "0") failures.push(`c. ${counts.twins} qb_import activos comparten TxnID con un documento vivo`);
  if (Number(counts.rows) !== Number(counts.checks) + Number(counts.transfers))
    failures.push(`d. filas pipeline confirmed adoptadas ${counts.rows} ≠ documentos adoptados vivos ${Number(counts.checks) + Number(counts.transfers)}`);

  for (const [table, prefix] of [["gl_check", "CHK"], ["gl_transfer", "TR"]] as const) {
    const s = await one<{ n: string; max: string; dups: string; disorder: string; counter: string; tmp: string }>(client, `
      WITH d AS (SELECT d.doc_number, substring(d.doc_number from '\\d+$')::int AS n, d.day, COALESCE(e.created_at, d.created_at) AS at
                   FROM ${table} d LEFT JOIN bank_journal_entry e ON e.id=d.entry_id WHERE d.deleted_at IS NULL AND d.doc_number NOT LIKE 'tmp:%')
      SELECT count(*)::text AS n, COALESCE(max(n),0)::text AS max, (count(*)-count(DISTINCT n))::text AS dups,
             (SELECT count(*) FROM (SELECT n, lag(n) OVER (ORDER BY day, at) AS prev FROM d) z WHERE prev IS NOT NULL AND prev > n)::text AS disorder,
             (SELECT value::text FROM document_number_counter WHERE name='${table}') AS counter,
             (SELECT count(*) FROM ${table} WHERE doc_number LIKE 'tmp:%' AND deleted_at IS NULL)::text AS tmp FROM d`);
    if (s.dups !== "0") failures.push(`e. ${prefix}: ${s.dups} números duplicados`);
    if (s.max !== s.n) failures.push(`e. ${prefix}: huecos (máximo ${s.max}, documentos ${s.n})`);
    if (s.disorder !== "0") failures.push(`e. ${prefix}: ${s.disorder} saltos hacia atrás — la serie no es cronológica`);
    if (s.counter !== s.n) failures.push(`e. ${prefix}: contador ${s.counter} ≠ ${s.n}`);
    if (s.tmp !== "0") failures.push(`e. ${prefix}: ${s.tmp} números temporales vivos`);
  }
  return { checks: Number(counts.checks), transfers: Number(counts.transfers), failures };
}
