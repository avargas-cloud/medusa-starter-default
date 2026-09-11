import type { PoolClient } from "pg";

import { BankingError } from "./security";

/**
 * banking-on-gl: a bank feed transaction is "claimed" once it is matched
 * (`bank_statement_match`, `book_kind='journal_line'`) against an `uncleared:<key>`
 * line of the GL `opening_balance` document — the replacement for the retired
 * `bank_opening_clear` table. Clearing an outstanding check/deposit-in-transit
 * from before the cutover IS the statement match; there is no separate ledger.
 */
export const JOURNAL_CLAIM_SQL = `SELECT m.id,jl.id AS item_id,e.reference FROM bank_statement_match m
  JOIN bank_statement_line l ON l.id=m.statement_line_id
  JOIN bank_journal_line jl ON jl.id=m.book_id
  JOIN bank_journal_entry e ON e.id=jl.entry_id
  WHERE l.transaction_id=$1 AND m.deleted_at IS NULL AND m.book_kind='journal_line' AND jl.role LIKE 'uncleared_%'`;

export function journalClaimExistsSql(transactionRef: string): string {
  return `EXISTS(SELECT 1 FROM bank_statement_match m
    JOIN bank_statement_line l ON l.id=m.statement_line_id
    JOIN bank_journal_line jl ON jl.id=m.book_id
    WHERE l.transaction_id=${transactionRef} AND m.deleted_at IS NULL
      AND m.book_kind='journal_line' AND jl.role LIKE 'uncleared_%')`;
}

export async function assertNoJournalClaim(
  client: PoolClient,
  id: string
): Promise<void> {
  if ((await client.query(JOURNAL_CLAIM_SQL, [id])).rowCount)
    throw new BankingError("BANKING_OPENING_TRANSACTION_CLAIMED", 409);
}

export async function journalClaimProjection<T extends { id: string }>(
  client: Pick<PoolClient, "query">,
  rows: T[]
): Promise<
  Array<
    T & {
      opening_clear?: { id: string; item_id: string; reference: string };
    }
  >
> {
  const claims = (
    await client.query<{
      id: string;
      transaction_id: string;
      item_id: string;
      reference: string;
    }>(
      `SELECT m.id,l.transaction_id,jl.id AS item_id,e.reference FROM bank_statement_match m
      JOIN bank_statement_line l ON l.id=m.statement_line_id
      JOIN bank_journal_line jl ON jl.id=m.book_id
      JOIN bank_journal_entry e ON e.id=jl.entry_id
      WHERE l.transaction_id=ANY($1::text[]) AND m.deleted_at IS NULL
        AND m.book_kind='journal_line' AND jl.role LIKE 'uncleared_%'`,
      [rows.map((row) => row.id)]
    )
  ).rows;
  return rows.map((row) => {
    const claim = claims.find((c) => c.transaction_id === row.id);
    return claim
      ? {
          ...row,
          opening_clear: {
            id: claim.id,
            item_id: claim.item_id,
            reference: claim.reference,
          },
        }
      : row;
  });
}
