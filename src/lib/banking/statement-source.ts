import type { PoolClient } from "pg";

import type { AccountingAccount } from "./accounting-types";
import { receiptAccounts, receiptMapping, receiptSetup } from "./receipts-setup";
import { reviewHash } from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError, bankingEnvSql } from "./security";
import type { StatementDocument, StatementInput } from "./statement-types";

/**
 * banking-on-gl: a statement's anchor is the GL `opening_balance` document for the
 * account (`bank_journal_entry.source_kind='opening_balance'`), not a declared
 * `bank_opening_balance` row. `cut_date` is the entry's own day; the statement
 * balance at cut is the `opening` role line's signed amount on this account.
 */
export async function statementBank(
  client: PoolClient,
  accountId: string
): Promise<{
  account: AccountingAccount;
  opening: { id: string; cut_date: string; statement_balance_cents: number };
}> {
  const setup = await receiptSetup(client);
  if (!setup) throw new BankingError("BANKING_RECEIPT_SETUP_REQUIRED", 409);
  const bank = (
    await client.query<{ qb_list_id: string }>(
      `SELECT a.qb_list_id FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
    WHERE a.id=$1 AND a.is_active AND a.is_selected AND a.currency='USD' AND a.type='depository'
      AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} FOR SHARE OF a,c`,
      [accountId]
    )
  ).rows[0];
  const live = bank?.qb_list_id
    ? (await receiptAccounts(client, [bank.qb_list_id]))[0]
    : null;
  const account = live ? receiptMapping(live, setup.attested) : null;
  if (!account || account.account_type !== "Bank" || account.currency !== "USD")
    throw new BankingError("BANKING_OPENING_ACCOUNT_INVALID", 409);
  const opening = (
    await client.query<{
      id: string;
      cut_date: string;
      statement_balance_cents: number;
    }>(
      `SELECT e.id,e.day AS cut_date,(l.debit_cents-l.credit_cents)::float8 AS statement_balance_cents
    FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='opening'
    -- A reversal copies every line (role included), so only kind='document' is the opening itself.
    WHERE e.source_kind='opening_balance' AND e.kind='document' AND e.source_id=$1 AND l.account_list_id=$1
      AND e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [account.id]
    )
  ).rows;
  if (opening.length !== 1)
    throw new BankingError("BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED", 409);
  return {
    account,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- opening.length===1 recién chequeado arriba garantiza opening[0]
    opening: opening[0]!,
  };
}

export async function statementLineFacts(
  client: PoolClient,
  line: StatementInput["lines"][number],
  accountListId: string
): Promise<{ snapshot: unknown; hash: string; blockers: string[] }> {
  const blockers: string[] = [];
  const document = {
    external_key: line.external_key,
    day: line.day,
    amount_cents: line.amount_cents,
    description: line.description,
    transaction_id: line.transaction_id,
  };
  if (!line.transaction_id)
    return {
      snapshot: { manual: true },
      hash: reviewHash({ manual: true, ...document }),
      blockers,
    };
  const source = (
    await client.query<{
      id: string;
      amount_cents: number;
      currency: string;
      status: string;
      day: string;
      source_version: number;
      deleted: boolean;
      account_list_id: string;
      active: boolean;
    }>(
      `SELECT t.id,
    (-t.amount::numeric*100)::float8 AS amount_cents,t.currency,t.status,t.transaction_date AS day,t.source_version,
    (t.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS deleted,a.qb_list_id AS account_list_id,
    (a.is_active AND a.is_selected AND a.type='depository' AND a.currency='USD' AND c.environment=${bankingEnvSql()}) AS active
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.id=$1 FOR SHARE OF t,a,c`,
      [line.transaction_id]
    )
  ).rows[0];
  if (
    !source ||
    source.deleted ||
    !source.active ||
    source.account_list_id !== accountListId ||
    source.currency !== "USD" ||
    source.status !== "posted" ||
    source.day !== line.day ||
    !Number.isSafeInteger(source.amount_cents) ||
    source.amount_cents !== line.amount_cents
  ) {
    blockers.push("BANKING_STATEMENT_LINE_SOURCE_INVALID");
  }
  const snapshot = source ?? { missing: true };
  return {
    snapshot,
    hash: reviewHash({ source: snapshot, ...document }),
    blockers,
  };
}

export function statementDocumentBlockers(
  input: Omit<StatementInput, "id" | "expected_revision">
): string[] {
  const blockers: string[] = [];
  const credit = input.lines.reduce(
    (sum, line) => sum + Math.max(line.amount_cents, 0),
    0
  );
  const debit = input.lines.reduce(
    (sum, line) => sum + Math.max(-line.amount_cents, 0),
    0
  );
  if (
    input.from > input.to ||
    input.to > reviewToday() ||
    input.lines.some((line) => line.day < input.from || line.day > input.to)
  )
    blockers.push("BANKING_STATEMENT_DATE_INVALID");
  if (
    !input.completeness_attested ||
    input.lines.length !== input.declared_line_count ||
    credit !== input.declared_credits_cents ||
    debit !== input.declared_debits_cents
  )
    blockers.push("BANKING_STATEMENT_DOCUMENT_INCOMPLETE");
  if (
    !Number.isSafeInteger(credit) ||
    !Number.isSafeInteger(debit) ||
    input.opening_balance_cents + credit - debit !== input.closing_balance_cents
  )
    blockers.push("BANKING_STATEMENT_TOTALS_DIFFER");
  if (
    new Set(input.lines.map((line) => line.external_key.trim().toLowerCase()))
      .size !== input.lines.length ||
    new Set(
      input.lines.flatMap((line) =>
        line.transaction_id ? [line.transaction_id] : []
      )
    ).size !== input.lines.filter((line) => line.transaction_id).length
  )
    blockers.push("BANKING_STATEMENT_DUPLICATE_LINE");
  return blockers;
}

export async function statementRow(
  client: PoolClient,
  id: string
): Promise<StatementDocument> {
  const row = (
    await client.query<{
      id: string;
      revision: number;
      status: "draft" | "closed";
      account_list_id: string;
      opening_id: string;
      predecessor_id: string | null;
      payload: Omit<StatementInput, "id" | "expected_revision" | "lines">;
      closed_by: string | null;
      closed_at: string | null;
      input_hash: string | null;
      closed_snapshot: StatementDocument["closed_snapshot"];
      history: unknown[];
    }>(
      "SELECT * FROM bank_statement WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_STATEMENT_NOT_FOUND", 404);
  return {
    ...row.payload,
    id: row.id,
    revision: row.revision,
    status: row.status,
    account_list_id: row.account_list_id,
    opening_id: row.opening_id,
    predecessor_id: row.predecessor_id,
    closed_by: row.closed_by,
    closed_at: row.closed_at,
    input_hash: row.input_hash,
    closed_snapshot: row.closed_snapshot,
    history: row.history,
  };
}

export async function statementPredecessor(
  client: PoolClient,
  account: string,
  from: string,
  id: string | null
): Promise<{
  id: string;
  status: string;
  to_day: string;
  closing_balance_cents: number;
  closed_snapshot: StatementDocument["closed_snapshot"];
} | null> {
  return (
    (
      await client.query<{
        id: string;
        status: string;
        to_day: string;
        closing_balance_cents: number;
        closed_snapshot: StatementDocument["closed_snapshot"];
      }>(
        `SELECT id,status,to_day,
    (payload->>'closing_balance_cents')::float8 AS closing_balance_cents,closed_snapshot FROM bank_statement
    WHERE account_list_id=$1 AND to_day<$2 AND id IS DISTINCT FROM $3::text AND deleted_at IS NULL
    ORDER BY to_day DESC LIMIT 1`,
        [account, from, id]
      )
    ).rows[0] ?? null
  );
}

export function nextStatementDay(day: string): string {
  const value = new Date(`${day}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
