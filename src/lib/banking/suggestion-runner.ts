import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { addCompletionEvidence } from "./completion-evidence";
import { feedPdf } from "./feed-evidence-pdf";
import { withReviewLock } from "./review-common";
import { reviewToday } from "./review-date";
import { bankingEnvSql } from "./security";
import { saveStatement } from "./statement-core";
import { extendDraftStatement } from "./statement-extend";
import { statementContext } from "./statement-read";
import { loadSuggestParams, suggestStatement, SUGGEST_ENGINE_VERSION } from "./statement-suggest";
import type { StatementContext } from "./statement-types";
import { transaction } from "./store";
import { closeSuggestionRun, openSuggestionRun, persistSuggestions, type SuggestionRunOutcome } from "./suggestion-store";

/**
 * Corrida de sugerencias por cuenta (job diario del worker, botón "Refresh suggestions", y el
 * recálculo tras un Confirm). Por cada cuenta seleccionada, mapeada y con setup:
 *   1. mantiene el borrador del MES EN CURSO al día (from = 1°, to = hoy) con `extendDraftStatement`
 *      — expand-only: nunca descasa, nunca borra una línea casada;
 *   2. mientras el mes ANTERIOR siga en borrador, lo extiende hasta su fin de mes (Plaid trae con
 *      1–3 d de atraso; las líneas del 29/30 llegan en el mes siguiente);
 *   3. crea el borrador del mes nuevo sólo cuando el anterior ya llegó a su fin de mes (la cadena
 *      opening = closing del anterior se mantiene);
 *   4. calcula el plan del casador y lo PERSISTE como sugerencias; métricas en `bank_suggestion_run`.
 * Un extracto cerrado es no-op registrado (`skipped`). Nunca escribe `bank_statement_match` ni documentos.
 */
export type SuggestionAccount = {
  id: string;
  name: string;
  mask: string;
  type: string;
  qb_list_id: string | null;
  review_start_date: string | null;
  selected: boolean;
};
export type SuggestionRunReport = {
  account_id: string;
  mask: string;
  month: string;
  statement_id: string | null;
  outcome: SuggestionRunOutcome;
  run_id: string;
};
export type RunOptions = {
  trigger: "job" | "manual" | "confirm";
  actorId: string;
  accountIds?: string[];
  statementIds?: string[];
  today?: string;
  toleranceDays?: number;
  bpToleranceDays?: number;
};

const key = (parts: string[]): string => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
const money = (c: number): string => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const monthOf = (day: string): string => day.slice(0, 7);
const firstOf = (month: string): string => `${month}-01`;
const lastOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const previousMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

type FeedLine = { external_key: string; day: string; amount_cents: number; description: string; transaction_id: string | null };
async function feedLines(db: Pick<PoolClient, "query">, accountId: string, from: string, to: string): Promise<{ lines: FeedLine[]; merchant: Map<string, string> }> {
  const rows = (
    await db.query<{ id: string; day: string; amount: string; name: string; merchant: string | null }>(
      `SELECT id,transaction_date::text AS day,amount::text,name,merchant_name AS merchant FROM bank_transaction
        WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND amount::numeric<>0 AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date,provider_transaction_id`,
      [accountId, from, to]
    )
  ).rows;
  return {
    lines: rows.map((r) => ({ external_key: r.id, day: r.day, amount_cents: -Math.round(Number(r.amount) * 100), description: r.name.slice(0, 500), transaction_id: r.id })),
    merchant: new Map(rows.map((r) => [r.id, (r.merchant ?? r.name).slice(0, 120)])),
  };
}

export async function listSuggestionAccounts(accountIds?: string[]): Promise<SuggestionAccount[]> {
  return (
    await getDbPool().query<SuggestionAccount>(
      `SELECT a.id,a.name,a.mask,a.type,a.qb_list_id,a.review_start_date::text AS review_start_date,a.is_selected AS selected
         FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
        WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
          AND a.is_selected AND a.type IN ('depository','credit') AND ($1::text[] IS NULL OR a.id=ANY($1::text[]))
        ORDER BY a.name`,
      [accountIds ?? null]
    )
  ).rows;
}

type StatementRow = { id: string; status: string; from_day: string; to_day: string; revision: number; closing: number };
async function monthStatement(db: Pick<PoolClient, "query">, accountId: string, month: string): Promise<StatementRow | null> {
  return (
    (
      await db.query<StatementRow>(
        `SELECT id,status,from_day::text AS from_day,to_day::text AS to_day,revision,(payload->>'closing_balance_cents')::float8 AS closing
           FROM bank_statement WHERE bank_account_id=$1 AND from_day=$2 AND deleted_at IS NULL ORDER BY to_day DESC LIMIT 1`,
        [accountId, firstOf(month)]
      )
    ).rows[0] ?? null
  );
}

/** Extiende (o crea) el borrador de `month` hasta `to`. Devuelve null si el mes está cerrado o no puede crearse todavía. */
async function maintainMonth(
  account: SuggestionAccount,
  month: string,
  to: string,
  actorId: string
): Promise<{ statement: StatementRow; appended: number; drifted: number; created: boolean } | { skipped: string }> {
  const pool = getDbPool();
  const from = firstOf(month);
  const current = await monthStatement(pool, account.id, month);
  if (current?.status === "closed") return { skipped: "closed" };
  const { lines } = await feedLines(pool, account.id, from, to);
  if (current) {
    const opening = (await pool.query<{ o: number }>(`SELECT (payload->>'opening_balance_cents')::float8 AS o FROM bank_statement WHERE id=$1`, [current.id])).rows[0]!.o;
    const closing = opening + lines.reduce((s, l) => s + l.amount_cents, 0);
    const r = await extendDraftStatement(current.id, actorId, key(["extend", current.id, String(current.revision), to, String(lines.length), String(closing)]), {
      to, closing_balance_cents: closing, lines,
    });
    return { statement: { ...current, to_day: to, revision: r.context.statement.revision, closing }, appended: r.appended + r.replaced, drifted: r.drifted, created: false };
  }
  // Mes nuevo: sólo cuando el anterior existe y ya llegó a su fin de mes (o está cerrado).
  const prev = (
    await pool.query<StatementRow>(
      `SELECT id,status,from_day::text AS from_day,to_day::text AS to_day,revision,(payload->>'closing_balance_cents')::float8 AS closing
         FROM bank_statement WHERE bank_account_id=$1 AND deleted_at IS NULL AND to_day<$2 ORDER BY to_day DESC LIMIT 1`,
      [account.id, from]
    )
  ).rows[0];
  if (!prev) return { skipped: "no_prior_statement" };
  if (prev.to_day !== lastOf(previousMonth(month))) return { skipped: "previous_month_incomplete" };
  const opening = prev.closing;
  const closing = opening + lines.reduce((s, l) => s + l.amount_cents, 0);
  const credits = lines.reduce((s, l) => s + Math.max(l.amount_cents, 0), 0);
  const debits = lines.reduce((s, l) => s + Math.max(-l.amount_cents, 0), 0);
  const evidence = await addCompletionEvidence(actorId, key(["evidence", account.id, from, to, String(lines.length)]), {
    name: `feed_${account.mask}_${from}_${to}.pdf`,
    mime_type: "application/pdf",
    content_base64: feedPdf(
      `${account.name} *${account.mask}  ${from}..${to}  opening ${money(opening)}  closing ${money(closing)}  (Plaid feed)`,
      lines.map((l) => `${l.day}  ${money(l.amount_cents).padStart(14)}  ${l.description.slice(0, 70)}`)
    ).toString("base64"),
  });
  const ctx = await saveStatement(actorId, key(["statement", account.id, from, to, String(lines.length)]), {
    expected_revision: 0, bank_account_id: account.id, from, to, reference: `Plaid feed ${account.mask} ${from}..${to}`,
    evidence_id: evidence.evidence.id, opening_balance_cents: opening, closing_balance_cents: closing,
    declared_line_count: lines.length, declared_credits_cents: credits, declared_debits_cents: debits, completeness_attested: true, lines,
  });
  return { statement: { id: ctx.statement.id, status: "draft", from_day: from, to_day: to, revision: ctx.statement.revision, closing }, appended: lines.length, drifted: 0, created: true };
}

/** Calcula y persiste las sugerencias de UN extracto en borrador. Devuelve el contexto leído. */
export async function computeSuggestionsForStatement(statementId: string, runId: string, opts: { toleranceDays?: number; bpToleranceDays?: number } = {}): Promise<{ ctx: StatementContext; suggested_lines: number; ambiguous_lines: number; candidates: number; matched_lines: number }> {
  const client = await getDbPool().connect();
  try {
    return await transaction(client, async () => {
      await withReviewLock(client);
      const ctx = await statementContext(client, statementId);
      const params = await loadSuggestParams(client, {
        account_list_id: ctx.statement.account_list_id, book_item_ids: ctx.book_items.map((b) => b.id), to: ctx.statement.to,
        toleranceDays: opts.toleranceDays ?? 5, bpToleranceDays: opts.bpToleranceDays ?? 45,
      });
      const plan = suggestStatement(ctx, params);
      const { merchant } = await feedLines(client, ctx.statement.bank_account_id, ctx.statement.from, ctx.statement.to);
      const counts = await persistSuggestions(client, ctx, plan, runId, merchant);
      return { ctx, ...counts, matched_lines: new Set(ctx.matches.map((m) => m.statement_line_id)).size };
    });
  } finally {
    client.release();
  }
}

/** Una cuenta, un mes. Registra la corrida pase lo que pase. */
export async function runSuggestionsForMonth(account: SuggestionAccount, month: string, options: RunOptions): Promise<SuggestionRunReport> {
  const pool = getDbPool();
  const today = options.today ?? reviewToday();
  const to = month === monthOf(today) ? today : lastOf(month);
  const runId = await openSuggestionRun(pool, { account_id: account.id, statement_id: null, month, trigger: options.trigger, actor_id: options.actorId, engine_version: SUGGEST_ENGINE_VERSION });
  const finish = async (outcome: SuggestionRunOutcome, statementId: string | null): Promise<SuggestionRunReport> => {
    await closeSuggestionRun(pool, runId, outcome, statementId);
    return { account_id: account.id, mask: account.mask, month, statement_id: statementId, outcome, run_id: runId };
  };
  if (!account.qb_list_id) return finish({ status: "skipped", skipped_reason: "not_mapped" }, null);
  if (!account.review_start_date) return finish({ status: "skipped", skipped_reason: "no_setup" }, null);
  try {
    const maintained = await maintainMonth(account, month, to, options.actorId);
    if ("skipped" in maintained) return finish({ status: "skipped", skipped_reason: maintained.skipped }, null);
    const computed = await computeSuggestionsForStatement(maintained.statement.id, runId, options);
    return finish(
      { status: "ok", lines: computed.ctx.lines.length, appended_lines: maintained.appended, drifted_lines: maintained.drifted, matched_lines: computed.matched_lines, suggested_lines: computed.suggested_lines, ambiguous_lines: computed.ambiguous_lines, candidates: computed.candidates },
      maintained.statement.id
    );
  } catch (error) {
    return finish({ status: "failed", error: error instanceof Error ? error.message : String(error) }, null);
  }
}

/** Todas las cuentas elegibles: mes anterior (si sigue en borrador) y mes en curso. */
export async function runSuggestions(options: RunOptions): Promise<SuggestionRunReport[]> {
  const today = options.today ?? reviewToday();
  const month = monthOf(today);
  const reports: SuggestionRunReport[] = [];
  for (const account of await listSuggestionAccounts(options.accountIds)) {
    const prev = await monthStatement(getDbPool(), account.id, previousMonth(month));
    if (prev && prev.status === "draft") reports.push(await runSuggestionsForMonth(account, previousMonth(month), options));
    reports.push(await runSuggestionsForMonth(account, month, options));
  }
  return reports;
}

/** Recalcular las sugerencias de UN extracto (tras un Confirm): sin extender, sin crear. */
export async function refreshStatementSuggestions(statementId: string, actorId: string, trigger: RunOptions["trigger"] = "confirm"): Promise<SuggestionRunReport> {
  const pool = getDbPool();
  const row = (await pool.query<{ account_id: string; mask: string; from_day: string; status: string }>(
    `SELECT s.bank_account_id AS account_id,a.mask,s.from_day::text AS from_day,s.status FROM bank_statement s JOIN bank_account a ON a.id=s.bank_account_id WHERE s.id=$1 AND s.deleted_at IS NULL`, [statementId]
  )).rows[0];
  if (!row) throw new Error("statement not found");
  const month = monthOf(row.from_day);
  const runId = await openSuggestionRun(pool, { account_id: row.account_id, statement_id: statementId, month, trigger, actor_id: actorId, engine_version: SUGGEST_ENGINE_VERSION });
  const finish = async (outcome: SuggestionRunOutcome): Promise<SuggestionRunReport> => {
    await closeSuggestionRun(pool, runId, outcome, statementId);
    return { account_id: row.account_id, mask: row.mask, month, statement_id: statementId, outcome, run_id: runId };
  };
  if (row.status !== "draft") return finish({ status: "skipped", skipped_reason: "closed" });
  try {
    const c = await computeSuggestionsForStatement(statementId, runId);
    return finish({ status: "ok", lines: c.ctx.lines.length, appended_lines: 0, drifted_lines: 0, matched_lines: c.matched_lines, suggested_lines: c.suggested_lines, ambiguous_lines: c.ambiguous_lines, candidates: c.candidates });
  } catch (error) {
    return finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}
