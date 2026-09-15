/**
 * Reopen chain (2026-09-15, policy rule 4 of docs/POLITICA_CORRECCIONES_CONTABLES.md).
 *
 * The next statement's opening is this one's closing balance, so a closed statement
 * can only be reopened together with every LATER closed statement of the same
 * account — newest first — and with every closed Month Close that covers any of
 * them. Decided as an AUTOMATIC chain: one click, one reason, one transaction
 * (the Month Close reopen runs on the same pg client through `pgSqlClient`).
 * Re-closing in order is already enforced by `BANKING_STATEMENT_PREDECESSOR_REQUIRED`.
 *
 * The operator previews the plan (`reopenChainPlan`) and confirms its `chain_hash`;
 * a statement or month that moved in between is `BANKING_STATEMENT_CHAIN_STALE`.
 * Permission is the same as closing: `reviewAccess(req, "close")`.
 */
import type { PoolClient } from "pg";

import { acquireBankAccountingPeriodLock } from "../accounting/banking-period-lock";
import { parseMonth } from "../accounting/month-close-data";
import {
  closedMonth,
  monthReopenPreview,
  postedAdjustmentOf,
  reopenClosedMonth,
} from "../accounting/month-close-reopen";
import { pgSqlClient } from "../accounting/pg-sql-client";

import { receiptRead } from "./receipts-setup";
import { reviewHash, runReviewCommand } from "./review-common";
import { BankingError } from "./security";
import {
  reopenStatementRow,
  statementPeriods,
} from "./statement-core";
import { statementContext } from "./statement-read";
import { statementRow } from "./statement-source";
import type { StatementContext, StatementDocument } from "./statement-types";
import { statementReopenChainSchema } from "./statement-types";

export type ChainStatement = {
  id: string;
  from: string;
  to: string;
  revision: number;
};
export type ChainMonth = {
  month: string;
  close_id: string;
  revision: number;
  input_hash: string;
};
export type ChainBlocker = {
  month: string;
  code: "posted_adjustment_must_be_reversed_first";
  adjustment: { id: string; target_period_start: string };
};
export type ReopenChainPlan = {
  target: ChainStatement;
  /** Newest first; the target is the last entry. */
  statements: ChainStatement[];
  /** Closed Month Closes covering any statement of the chain, ascending. */
  months: ChainMonth[];
  blockers: ChainBlocker[];
  chain_hash: string;
};

const asChain = (row: {
  id: string;
  from: string;
  to: string;
  revision: number;
}): ChainStatement => ({
  id: row.id,
  from: row.from,
  to: row.to,
  revision: row.revision,
});

/** Newest → oldest, target last; the target never repeats. */
export function orderReopenChain(
  target: ChainStatement,
  later: ChainStatement[]
): ChainStatement[] {
  const rest = later
    .filter((row) => row.id !== target.id)
    .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
  return [...rest, asChain(target)];
}

/** Every calendar month (YYYY-MM) any statement of the chain touches, ascending, once. */
export function chainMonths(chain: ChainStatement[]): string[] {
  const months = new Set<string>();
  for (const statement of chain) {
    for (let month = statement.from.slice(0, 7); month <= statement.to.slice(0, 7); ) {
      months.add(month);
      const date = new Date(`${month}-01T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + 1);
      month = date.toISOString().slice(0, 7);
    }
  }
  return [...months].sort();
}

export function chainHash(plan: {
  statements: ChainStatement[];
  months: ChainMonth[];
}): string {
  return reviewHash({
    statements: plan.statements.map((row) => ({ id: row.id, revision: row.revision })),
    months: plan.months.map((row) => ({
      month: row.month,
      close_id: row.close_id,
      revision: row.revision,
      input_hash: row.input_hash,
    })),
  });
}

/** Same criterion as `LATER_CLOSED_STATEMENT_SQL`, all rows, newest first. */
export const LATER_CLOSED_STATEMENTS_SQL = `SELECT id,from_day AS "from",to_day AS "to",revision FROM bank_statement
  WHERE account_list_id=$1 AND id<>$2 AND status='closed' AND deleted_at IS NULL AND from_day>$3
  ORDER BY from_day DESC`;

export async function reopenChainPlan(
  client: PoolClient,
  target: StatementDocument
): Promise<ReopenChainPlan> {
  const later = (
    await client.query<ChainStatement>(LATER_CLOSED_STATEMENTS_SQL, [
      target.account_list_id,
      target.id,
      target.to,
    ])
  ).rows;
  const statements = orderReopenChain(asChain(target), later);
  const db = pgSqlClient(client);
  const months: ChainMonth[] = [];
  const blockers: ChainBlocker[] = [];
  for (const month of chainMonths(statements)) {
    const range = parseMonth(month);
    if (!range) continue;
    const close = await closedMonth(db, range);
    if (!close) continue;
    const adjustment = await postedAdjustmentOf(db, close.id);
    if (adjustment) {
      blockers.push({
        month,
        code: "posted_adjustment_must_be_reversed_first",
        adjustment,
      });
      continue;
    }
    const preview = await monthReopenPreview(db, range);
    if (!preview) continue;
    months.push({
      month,
      close_id: preview.close.id,
      revision: preview.close.revision,
      input_hash: preview.input_hash,
    });
  }
  return {
    target: asChain(target),
    statements,
    months,
    blockers,
    chain_hash: chainHash({ statements, months }),
  };
}

export async function previewReopenChain(id: string): Promise<ReopenChainPlan> {
  return receiptRead(async (client) => {
    const target = await statementRow(client, id);
    if (target.status !== "closed")
      throw new BankingError("BANKING_STATEMENT_STALE", 409);
    return reopenChainPlan(client, target);
  });
}

export type ReopenChainResult = StatementContext & {
  chain: {
    reopened: ChainStatement[];
    months: Array<{ month: string; close_id: string }>;
  };
};

export async function reopenStatementChain(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<ReopenChainResult> {
  const body = statementReopenChainSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "statement_reopen_chain", entityId: id, body },
    async (client) => {
      const target = await statementRow(client, id);
      if (target.status !== "closed" || target.revision !== body.expected_revision)
        throw new BankingError("BANKING_STATEMENT_STALE", 409);
      const plan = await reopenChainPlan(client, target);
      if (plan.chain_hash !== body.chain_hash)
        throw new BankingError("BANKING_STATEMENT_CHAIN_STALE", 409);
      if (plan.blockers.length)
        throw new BankingError("BANKING_MONTH_REOPEN_BLOCKED", 409);
      // Period locks first (same key the knex Month Close writers take), then the
      // months, then the statements newest → target; `statementPeriods` re-asserts
      // each month is open once the closes above it are gone.
      for (const month of chainMonths(plan.statements))
        await acquireBankAccountingPeriodLock(client, `${month}-01`);
      const db = pgSqlClient(client);
      const last = plan.statements[0] ?? plan.target;
      const monthReason = `Bank statement reopen chain ${plan.target.id} (${plan.target.from} → ${last.to}): ${body.reason}`;
      const months: ReopenChainResult["chain"]["months"] = [];
      for (const month of plan.months) {
        const range = parseMonth(month.month);
        if (!range) throw new BankingError("BANKING_MONTH_REOPEN_BLOCKED", 409);
        const result = await reopenClosedMonth(db, {
          range,
          actorId,
          reason: monthReason,
          input_hash: month.input_hash,
        });
        if (result.status !== 200)
          throw new BankingError("BANKING_MONTH_REOPEN_BLOCKED", 409);
        months.push({ month: month.month, close_id: month.close_id });
      }
      const reopened: ChainStatement[] = [];
      for (const [index, entry] of plan.statements.entries()) {
        const row = await statementRow(client, entry.id);
        if (row.status !== "closed" || row.revision !== entry.revision)
          throw new BankingError("BANKING_STATEMENT_CHAIN_STALE", 409);
        await statementPeriods(client, row.from, row.to);
        await reopenStatementRow(client, row, actorId, body.reason, {
          chain: {
            root: plan.target.id,
            position: index + 1,
            of: plan.statements.length,
            months: months.map((month) => month.month),
          },
        });
        reopened.push(entry);
      }
      return {
        ...(await statementContext(client, id)),
        chain: { reopened, months },
      };
    }
  );
}
