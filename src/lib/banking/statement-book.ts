import type { PoolClient } from "pg";

import { accountingContext } from "./accounting-read";
import { merchantReceiptDrift } from "./merchant-receipts";
import { movementContext } from "./movement-read";
import { receiptContext } from "./receipts-read";
import { reviewHash } from "./review-common";
import { BankingError } from "./security";
import { settlementContext } from "./settlement-read";
import type { StatementBookItem, StatementDocument } from "./statement-types";

type BankLine = {
  id: string;
  entry_id: string;
  role: string;
  day: string;
  reference: string;
  description: string;
  amount_cents: number;
  source_hash: string;
  kind: string;
  transaction_id: string | null;
  deposit_id: string | null;
  receipt_payment_id: string | null;
  completion_id: string | null;
  effective_kind: string;
  canceled_by_end: boolean;
};
async function bookSourceBlockers(
  client: PoolClient,
  row: BankLine
): Promise<string[]> {
  if (row.canceled_by_end) return [];
  // The GL opening_balance document is always a valid, self-contained source —
  // its `opening` line is already cleared against the cut-date statement, and
  // its `uncleared_<key>` lines clear via the ordinary statement match.
  if (row.kind === "opening_balance") return [];
  try {
    if (row.effective_kind === "expense" && row.transaction_id) {
      const context = await accountingContext(client, row.transaction_id);
      return [
        ...context.blockers,
        ...(context.history.some(
          (entry) => entry.id === row.entry_id && entry.stale
        )
          ? ["BANKING_STATEMENT_BOOK_SOURCE_DRIFT"]
          : []),
      ];
    }
    if (row.effective_kind === "payment_match" && row.transaction_id)
      return (await receiptContext(client, "payment_match", row.transaction_id))
        .blockers;
    if (row.effective_kind === "deposit" && row.deposit_id)
      return (await receiptContext(client, "deposit", row.deposit_id)).blockers;
    if (row.effective_kind === "receipt" && row.receipt_payment_id)
      return (await receiptContext(client, "receipt", row.receipt_payment_id))
        .blockers;
    if (row.effective_kind === "movement" && row.completion_id)
      return (await movementContext(client, row.completion_id)).blockers;
    if (row.effective_kind === "merchant_settlement" && row.completion_id)
      return (await settlementContext(client, row.completion_id)).blockers;
    if (row.effective_kind === "merchant_receipt" && row.completion_id)
      return merchantReceiptDrift(client, row.completion_id);
    return ["BANKING_STATEMENT_BOOK_SOURCE_UNSUPPORTED"];
  } catch (error) {
    if (!(error instanceof BankingError)) throw error;
    return [error.code];
  }
}

/**
 * banking-on-gl: the book balance is `Σ(debit-credit)` of every active Bank line
 * of the account through `to` — no separate opening term, no lower bound, since
 * the GL opening_balance document IS the first line (dated at cut). Its `opening`
 * role line is always fully cleared (never pending); its `uncleared_<key>` lines
 * (former outstanding checks / deposits in transit) are ordinary pending lines
 * until matched, exactly like any other journal line.
 */
export async function statementBook(
  client: PoolClient,
  statement: StatementDocument
): Promise<{
  items: StatementBookItem[];
  book_balance_cents: number;
}> {
  const lines = (
    await client.query<BankLine>(
      `SELECT l.id,e.id AS entry_id,l.role,e.day,e.reference,e.description,
    (l.debit_cents-l.credit_cents)::float8 AS amount_cents,e.source_hash,e.kind,e.transaction_id,e.deposit_id,e.completion_id,
    a.payment_id AS receipt_payment_id,COALESCE(original.kind,e.kind) AS effective_kind,
    (EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id AND r.day<=$2)
      OR (e.kind='reversal' AND e.day<=$2)) AS canceled_by_end
    FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
    LEFT JOIN bank_journal_entry original ON original.id=e.reverses_entry_id
    LEFT JOIN bank_receipt_accounting a ON a.id=e.receipt_id
    WHERE l.account_list_id=$1 AND l.account_snapshot->>'account_type'='Bank' AND e.day<=$2
    ORDER BY e.day,e.created_at,l.id LIMIT 10001`,
      [statement.account_list_id, statement.to]
    )
  ).rows;
  if (lines.length > 10000)
    throw new BankingError("BANKING_STATEMENT_BOOK_CAP_REACHED", 409);
  const consumed = (
    await client.query<{ book_kind: string; book_id: string; cents: number }>(
      `SELECT m.book_kind,m.book_id,
    SUM(m.amount_cents)::float8 AS cents FROM bank_statement_match m JOIN bank_statement s ON s.id=m.statement_id
    WHERE s.account_list_id=$1 AND s.to_day<=$2 AND m.deleted_at IS NULL GROUP BY m.book_kind,m.book_id`,
      [statement.account_list_id, statement.to]
    )
  ).rows;
  const amountByBook = new Map(
    consumed.map((row) => [`${row.book_kind}:${row.book_id}`, row.cents])
  );
  const cache = new Map<string, string[]>(),
    items: StatementBookItem[] = [];
  for (const line of lines) {
    const origin = `${line.effective_kind}:${line.completion_id ?? line.deposit_id ?? line.transaction_id ?? line.receipt_payment_id}:${line.canceled_by_end}`;
    if (!cache.has(origin))
      cache.set(origin, await bookSourceBlockers(client, line));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the `if (!cache.has(origin))` above just populated this key, so it is always present
    const blockers = cache.get(origin)!;
    // The `opening` line is always fully cleared: it is the cut-date balance
    // already reconciled in the statement it anchors, never a pending item.
    const alwaysCleared = line.role === "opening";
    const matched = alwaysCleared
      ? Math.abs(line.amount_cents)
      : (amountByBook.get(`journal_line:${line.id}`) ?? 0);
    items.push({
      kind: "journal_line",
      id: line.id,
      day: line.day,
      reference: line.reference,
      description: line.description,
      amount_cents: line.amount_cents,
      matched_cents: matched,
      remaining_cents: Math.abs(line.amount_cents) - matched,
      source_hash: reviewHash({
        id: line.id,
        amount: line.amount_cents,
        source_hash: line.source_hash,
        blockers,
      }),
      transaction_id: line.transaction_id,
      blockers,
    });
  }
  const bookBalance = lines.reduce((sum, line) => sum + line.amount_cents, 0);
  if (!Number.isSafeInteger(bookBalance))
    throw new BankingError("BANKING_STATEMENT_AMOUNT_INVALID", 409);
  return { items, book_balance_cents: bookBalance };
}
