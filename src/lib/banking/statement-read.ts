import type { PoolClient } from "pg";

import { completionEvidence } from "./completion-evidence";
import { receiptRead } from "./receipts-setup";
import { reviewHash } from "./review-common";
import { BankingError } from "./security";
import { statementBook } from "./statement-book";
import {
  nextStatementDay,
  statementBank,
  statementDocumentBlockers,
  statementLineFacts,
  statementPredecessor,
  statementRow,
} from "./statement-source";
import type {
  StatementContext,
  StatementLine,
  StatementMatch,
  StatementSnapshot,
} from "./statement-types";

export async function statementContext(
  client: PoolClient,
  id: string
): Promise<StatementContext> {
  const statement = await statementRow(client, id),
    blockers: string[] = [];
  const lines = (
    await client.query<StatementLine>(
      `SELECT id,statement_id,external_key,day,amount_cents::float8 AS amount_cents,
    description,transaction_id,source_hash,source_snapshot FROM bank_statement_line
    WHERE statement_id=$1 AND deleted_at IS NULL ORDER BY day,id`,
      [id]
    )
  ).rows;
  const matches = (
    await client.query<StatementMatch>(
      `SELECT id,statement_line_id,book_kind,book_id,
    amount_cents::float8 AS amount_cents,book_hash,line_hash FROM bank_statement_match
    WHERE statement_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [id]
    )
  ).rows;
  for (const line of lines) {
    const current = await statementLineFacts(
      client,
      line,
      statement.account_list_id
    );
    line.blockers = [...current.blockers];
    if (current.hash !== line.source_hash)
      line.blockers.push("BANKING_STATEMENT_LINE_SOURCE_DRIFT");
    line.matched_cents = matches
      .filter((match) => match.statement_line_id === line.id)
      .reduce((sum, match) => sum + match.amount_cents, 0);
    line.remaining_cents = Math.abs(line.amount_cents) - line.matched_cents;
    if (line.remaining_cents !== 0)
      blockers.push("BANKING_STATEMENT_UNMATCHED_LINES");
    blockers.push(...line.blockers);
  }
  blockers.push(...statementDocumentBlockers({ ...statement, lines }));
  try {
    const mapped = await statementBank(client, statement.bank_account_id);
    if (
      mapped.account.id !== statement.account_list_id ||
      mapped.opening.id !== statement.opening_id
    )
      blockers.push("BANKING_STATEMENT_MAPPING_STALE");
  } catch (error) {
    if (!(error instanceof BankingError)) throw error;
    blockers.push(error.code);
  }
  const evidence = await completionEvidence(client, statement.evidence_id);
  const book = await statementBook(client, statement);
  for (const item of book.items) blockers.push(...item.blockers);
  for (const match of matches) {
    const item = book.items.find(
      (row) => row.id === match.book_id && row.kind === match.book_kind
    );
    const line = lines.find((row) => row.id === match.statement_line_id);
    if (
      !item ||
      !line ||
      item.source_hash !== match.book_hash ||
      line.source_hash !== match.line_hash
    )
      blockers.push("BANKING_STATEMENT_MATCH_SOURCE_DRIFT");
  }
  const previous = await statementPredecessor(
    client,
    statement.account_list_id,
    statement.from,
    statement.id
  );
  if (previous) {
    if (
      previous.id !== statement.predecessor_id ||
      previous.status !== "closed" ||
      nextStatementDay(previous.to_day) !== statement.from ||
      previous.closing_balance_cents !== statement.opening_balance_cents
    )
      blockers.push("BANKING_STATEMENT_PREDECESSOR_REQUIRED");
    // Every carried identity remains present; its signed original amount cannot silently change.
    for (const carried of previous.closed_snapshot?.outstanding ?? []) {
      const item = book.items.find(
        (row) => row.kind === carried.kind && row.id === carried.id
      );
      const currentUsed = matches
        .filter(
          (match) =>
            match.book_kind === carried.kind && match.book_id === carried.id
        )
        .reduce((sum, match) => sum + match.amount_cents, 0);
      if (
        !item ||
        Math.sign(item.amount_cents) !== Math.sign(carried.amount_cents) ||
        item.remaining_cents + currentUsed !== Math.abs(carried.amount_cents) ||
        item.source_hash !== carried.source_hash
      )
        blockers.push("BANKING_STATEMENT_CARRYFORWARD_DRIFT");
    }
  } else if (
    statement.predecessor_id ||
    statement.from !== book.opening.cut_date ||
    statement.opening_balance_cents !== book.opening.statement_balance_cents
  )
    blockers.push("BANKING_STATEMENT_PREDECESSOR_REQUIRED");
  const feedGaps = await client.query(
    `SELECT t.id FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
    WHERE a.qb_list_id=$1 AND t.status='posted' AND t.deleted_at IS NULL AND t.transaction_date BETWEEN $2 AND $3
    AND NOT EXISTS(SELECT 1 FROM bank_statement_line l WHERE l.statement_id=$4 AND l.transaction_id=t.id AND l.deleted_at IS NULL) LIMIT 1`,
    [statement.account_list_id, statement.from, statement.to, id]
  );
  if (feedGaps.rowCount) blockers.push("BANKING_STATEMENT_FEED_UNREPRESENTED");
  const transit = book.items
    .filter((item) => item.amount_cents > 0)
    .reduce((sum, item) => sum + item.remaining_cents, 0);
  const disbursements = book.items
    .filter((item) => item.amount_cents < 0)
    .reduce((sum, item) => sum + item.remaining_cents, 0);
  const difference =
    book.book_balance_cents -
    statement.closing_balance_cents -
    transit +
    disbursements;
  if (difference !== 0) blockers.push("BANKING_STATEMENT_DIFFERENCE");
  const sourceHash = reviewHash({
    statement: {
      ...statement,
      status: undefined,
      revision: undefined,
      closed_by: undefined,
      closed_at: undefined,
      input_hash: undefined,
      closed_snapshot: undefined,
      history: undefined,
    },
    lines: lines.map((line) => ({
      id: line.id,
      hash: line.source_hash,
      blockers: line.blockers,
      matched: line.matched_cents,
    })),
    book: book.items,
    matches,
    evidence,
    previous: previous?.closed_snapshot ?? null,
    blockers: [...new Set(blockers)].sort(),
  });
  return {
    statement,
    lines,
    book_items: book.items,
    matches,
    blockers: [...new Set(blockers)],
    difference_cents: difference,
    book_balance_cents: book.book_balance_cents,
    deposits_in_transit_cents: transit,
    outstanding_disbursements_cents: disbursements,
    source_hash: sourceHash,
    needs_review:
      statement.status === "closed" &&
      (statement.input_hash !== sourceHash || blockers.length > 0),
    coverage: "bank_account_period",
    global_ledger_coverage: "partial",
    zero_gl: true,
  };
}
export function statementSnapshot(
  context: StatementContext,
  evidenceHash: string
): StatementSnapshot {
  return {
    opening_id: context.statement.opening_id,
    account_list_id: context.statement.account_list_id,
    from: context.statement.from,
    to: context.statement.to,
    statement_balance_cents: context.statement.closing_balance_cents,
    book_balance_cents: context.book_balance_cents,
    outstanding: context.book_items
      .filter((item) => item.remaining_cents > 0)
      .map((item) => ({
        kind: item.kind,
        id: item.id,
        amount_cents: item.remaining_cents * Math.sign(item.amount_cents),
        source_hash: item.source_hash,
      })),
    lines: context.lines.map((line) => ({
      id: line.id,
      hash: line.source_hash,
      amount_cents: line.amount_cents,
    })),
    matches: context.matches,
    evidence_hash: evidenceHash,
  };
}
export const readStatement = (id: string): Promise<StatementContext> =>
  receiptRead((client) => statementContext(client, id));
export const listStatements = (): Promise<{
  statements: Record<string, unknown>[];
}> =>
  receiptRead(async (client) => ({
    statements: (
      await client.query(`SELECT id,revision,status,
  account_list_id,bank_account_id,from_day AS "from",to_day AS "to",payload->>'reference' AS reference,
  (payload->>'closing_balance_cents')::float8 AS closing_balance_cents,closed_at FROM bank_statement
  WHERE deleted_at IS NULL ORDER BY from_day DESC,id DESC LIMIT 36`)
    ).rows,
  }));
