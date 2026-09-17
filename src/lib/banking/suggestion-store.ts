import type { Pool, PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { expectedHintsByTransaction, type FeedExpectedHint } from "../calendar/feed-expected-hints";

import { bankingEnvSql, requireBankingEnabled } from "./security";
import type { LineSuggestion, SuggestCandidate, SuggestPlan } from "./statement-suggest-types";
import type { StatementContext } from "./statement-types";
import { bankId } from "./store";

/**
 * Persistencia de las sugerencias del casador por línea de extracto (`bank_statement_suggestion`)
 * y de las métricas de cada corrida (`bank_suggestion_run`). Escribe sólo sugerencias: jamás un
 * `bank_statement_match` (el contador confirma) ni un documento.
 */
type Queryable = Pick<Pool | PoolClient, "query">;

export type SuggestionRunInput = {
  account_id: string;
  statement_id: string | null;
  month: string;
  trigger: "job" | "manual" | "confirm";
  actor_id: string | null;
  engine_version: string;
};
export type SuggestionRunOutcome =
  | { status: "ok"; lines: number; appended_lines: number; drifted_lines: number; matched_lines: number; suggested_lines: number; ambiguous_lines: number; candidates: number }
  | { status: "skipped"; skipped_reason: string }
  | { status: "failed"; error: string };

export async function openSuggestionRun(db: Queryable, input: SuggestionRunInput): Promise<string> {
  const id = bankId("bsr");
  await db.query(
    `INSERT INTO bank_suggestion_run(id,account_id,statement_id,month,trigger,actor_id,engine_version,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,'ok')`,
    [id, input.account_id, input.statement_id, input.month, input.trigger, input.actor_id, input.engine_version]
  );
  return id;
}

export async function closeSuggestionRun(db: Queryable, id: string, outcome: SuggestionRunOutcome, statementId: string | null): Promise<void> {
  const base = `finished_at=now(),duration_ms=EXTRACT(EPOCH FROM (now()-started_at))*1000,updated_at=now(),statement_id=COALESCE($2,statement_id)`;
  if (outcome.status === "ok")
    await db.query(
      `UPDATE bank_suggestion_run SET ${base},status='ok',lines=$3,appended_lines=$4,drifted_lines=$5,matched_lines=$6,suggested_lines=$7,ambiguous_lines=$8,candidates=$9 WHERE id=$1`,
      [id, statementId, outcome.lines, outcome.appended_lines, outcome.drifted_lines, outcome.matched_lines, outcome.suggested_lines, outcome.ambiguous_lines, outcome.candidates]
    );
  else if (outcome.status === "skipped")
    await db.query(`UPDATE bank_suggestion_run SET ${base},status='skipped',skipped_reason=$3 WHERE id=$1`, [id, statementId, outcome.skipped_reason]);
  else await db.query(`UPDATE bank_suggestion_run SET ${base},status='failed',error=$3 WHERE id=$1`, [id, statementId, outcome.error.slice(0, 2000)]);
}

/** "Card Charge CHK-0289 — Sedano's" → "Sedano's"; sin guion, el texto entero. */
export function payeeFromDescription(description: string): string | null {
  const m = /—\s*(.+)$/.exec(description);
  const out = (m?.[1] ?? description).trim();
  return out ? out.slice(0, 120) : null;
}

/** Reemplaza las sugerencias del extracto por las del plan (upsert por línea; las líneas que ya no existen se retiran). */
export async function persistSuggestions(
  db: Queryable,
  ctx: StatementContext,
  plan: SuggestPlan,
  runId: string,
  merchantByTx: ReadonlyMap<string, string>
): Promise<{ suggested_lines: number; ambiguous_lines: number; candidates: number }> {
  const liveLineIds = ctx.lines.map((l) => l.id);
  await db.query(
    `UPDATE bank_statement_suggestion SET deleted_at=now(),updated_at=now()
      WHERE statement_id=$1 AND deleted_at IS NULL AND NOT (statement_line_id=ANY($2::text[]))`,
    [ctx.statement.id, liveLineIds]
  );
  let suggested = 0, ambiguous = 0, candidates = 0;
  for (const line of ctx.lines) {
    const s: LineSuggestion = plan.by_line.get(line.id) ?? { line_id: line.id, kind: "none", candidates: [], alternatives: [] };
    if (s.kind === "match") { suggested += 1; candidates += s.candidates.length; }
    if (s.kind === "ambiguous") { ambiguous += 1; candidates += s.alternatives.length; }
    const payee =
      s.kind === "match" && s.candidates[0]
        ? payeeFromDescription(s.candidates[0].description)
        : line.transaction_id ? (merchantByTx.get(line.transaction_id) ?? null) : null;
    await db.query(
      `INSERT INTO bank_statement_suggestion(id,statement_id,statement_line_id,transaction_id,account_id,kind,stage,candidates,alternatives,payee_name,engine_version,statement_revision,run_id,computed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,now())
       ON CONFLICT (statement_line_id) WHERE deleted_at IS NULL DO UPDATE SET
         kind=EXCLUDED.kind,stage=EXCLUDED.stage,candidates=EXCLUDED.candidates,alternatives=EXCLUDED.alternatives,
         payee_name=EXCLUDED.payee_name,engine_version=EXCLUDED.engine_version,statement_revision=EXCLUDED.statement_revision,
         run_id=EXCLUDED.run_id,computed_at=now(),updated_at=now(),transaction_id=EXCLUDED.transaction_id`,
      [
        bankId("bss"), ctx.statement.id, line.id, line.transaction_id, ctx.statement.bank_account_id,
        s.kind, "stage" in s ? s.stage : null, JSON.stringify(s.candidates), JSON.stringify(s.alternatives), payee,
        plan.engine_version, ctx.statement.revision, runId,
      ]
    );
  }
  return { suggested_lines: suggested, ambiguous_lines: ambiguous, candidates };
}

export type FeedSuggestion = {
  transaction_id: string;
  statement_id: string;
  statement_line_id: string;
  statement_status: "draft" | "closed";
  statement_from: string;
  statement_to: string;
  statement_revision: number;
  stale: boolean;
  kind: "match" | "ambiguous" | "none";
  stage: string | null;
  candidates: SuggestCandidate[];
  alternatives: SuggestCandidate[];
  payee_name: string | null;
  /** Categoría sugerida por una regla del producto (`bank_review_rule` → review draft `origin='rule'`). */
  category: { list_id: string; name: string; rule_id: string | null } | null;
  engine_version: string;
  computed_at: string;
  /**
   * calendar-workqueue-20260917: ocurrencias ESPERADAS del Accounting Calendar que esta
   * salida podría ser (misma cuenta pagadora, monto en tolerancia, fecha cercana), mejor
   * primero. Calculado al leer, nunca persistido — no es un candidato del libro.
   */
  expected: FeedExpectedHint[];
};

/** Lectura para el feed: por ids de transacción o por día. Sólo líneas de borradores (lo cerrado no se sugiere). */
export async function readFeedSuggestions(input: { ids?: string[]; date?: string }): Promise<{ suggestions: FeedSuggestion[]; last_run: { finished_at: string; status: string } | null }> {
  requireBankingEnabled();
  const pool = getDbPool();
  const rows = (
    await pool.query<FeedSuggestion>(
      `SELECT g.transaction_id,g.statement_id,g.statement_line_id,st.status AS statement_status,st.from_day::text AS statement_from,
              st.to_day::text AS statement_to,g.statement_revision,(st.revision<>g.statement_revision) AS stale,g.kind,g.stage,
              g.candidates,g.alternatives,g.payee_name,g.engine_version,g.computed_at::text AS computed_at,
              CASE WHEN r.id IS NOT NULL AND r.status='draft' AND r.origin='rule' AND r.category_list_id IS NOT NULL THEN
                (SELECT jsonb_build_object('list_id',qa.qb_list_id,'name',qa.full_name,'rule_id',r.rule_id) FROM qb_account qa
                  WHERE qa.qb_list_id=r.category_list_id AND qa.deleted_at IS NULL AND qa.is_active AND qa.account_type<>'NonPosting' LIMIT 1)
              ELSE NULL END AS category
         FROM bank_statement_suggestion g
         JOIN bank_statement st ON st.id=g.statement_id AND st.deleted_at IS NULL
         JOIN bank_transaction t ON t.id=g.transaction_id AND t.deleted_at IS NULL
         JOIN bank_account a ON a.id=t.account_id AND a.deleted_at IS NULL
         JOIN bank_connection c ON c.id=a.connection_id AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
         LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id AND r.deleted_at IS NULL
        WHERE g.deleted_at IS NULL AND st.status='draft'
          AND (($1::text[] IS NOT NULL AND g.transaction_id=ANY($1::text[])) OR ($2::text IS NOT NULL AND t.transaction_date=$2::text))
        ORDER BY g.transaction_id`,
      [input.ids ?? null, input.date ?? null]
    )
  ).rows;
  const last = (
    await pool.query<{ finished_at: string; status: string }>(
      `SELECT finished_at::text AS finished_at,status FROM bank_suggestion_run WHERE finished_at IS NOT NULL AND deleted_at IS NULL ORDER BY finished_at DESC LIMIT 1`
    )
  ).rows[0];
  const hints = await expectedHintsByTransaction(rows.filter((r) => r.kind !== "match").map((r) => r.transaction_id));
  const suggestions = rows.map((r) => ({ ...r, expected: hints.get(r.transaction_id) ?? [] }));
  return { suggestions, last_run: last ?? null };
}
