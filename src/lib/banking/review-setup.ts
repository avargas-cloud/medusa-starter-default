import { z } from "zod";
import type { PoolClient } from "pg";
import { BankingError, bankingEnvSql } from "./security";
import { runReviewCommand } from "./review-common";
import { openingAmount, reviewDate, reviewToday } from "./review-date";
import { applyRulesForAccounts } from "./review-rule-apply";

export const accountSetupSchema = z.object({
  expected_revision: z.number().int().min(0),
  review_start_date: reviewDate,
  opening_bank_balance: openingAmount,
  opening_reference: z.string().trim().min(1).max(500),
  opening_book_balance: openingAmount.nullable().optional(),
}).strict();

/** Even reversed history fixes the account's original opening/mapping context. */
export async function requireUnpostedBankAccount(client: PoolClient, accountId: string): Promise<void> {
  const posted = await client.query(`SELECT entry.id FROM bank_journal_entry entry
    LEFT JOIN bank_transaction tx ON tx.id=entry.transaction_id
    LEFT JOIN bank_deposit deposit ON deposit.id=entry.deposit_id
    WHERE tx.account_id=$1 OR deposit.account_id=$1 LIMIT 1`, [accountId]);
  const opening = await client.query(`SELECT b.id FROM bank_opening_balance b JOIN bank_account a ON a.qb_list_id=b.account_list_id
    WHERE a.id=$1 AND b.kind='bank' AND b.status='adopted' LIMIT 1`, [accountId]);
  if (posted.rowCount || opening.rowCount) throw new BankingError("BANKING_ACCOUNTING_SETUP_FROZEN", 409);
}

export async function saveAccountSetup(actorId: string, accountId: string, key: string | undefined,
  body: z.infer<typeof accountSetupSchema>) {
  return runReviewCommand({ actorId, operation: "account_setup", entityId: accountId, key, body }, async client => {
    if (body.review_start_date > reviewToday()) throw new BankingError("BANKING_FUTURE_START_DATE", 400);
    const row = (await client.query<{ setup_revision: number; currency: string | null }>(
      `SELECT a.setup_revision,a.currency FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
       WHERE a.id=$1 AND a.deleted_at IS NULL AND c.environment=${bankingEnvSql()} AND c.deleted_at IS NULL FOR UPDATE OF a`, [accountId])).rows[0];
    if (!row) throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
    if (row.setup_revision !== body.expected_revision) throw new BankingError("BANKING_REVIEW_CONFLICT", 409);
    if (!row.currency) throw new BankingError("BANKING_CURRENCY_REQUIRED", 409);
    await requireUnpostedBankAccount(client, accountId);
    const closed = await client.query(`SELECT id FROM bank_day_close
      WHERE status='closed' AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot->'accounts','[]'::jsonb)) b
          WHERE b->'account'->>'id'=$1) LIMIT 1`, [accountId]);
    if (closed.rowCount) throw new BankingError("BANKING_REOPEN_REQUIRED", 409);
    const result = await client.query(`UPDATE bank_account SET review_start_date=$2::text,
      opening_bank_balance=$3::numeric::text,opening_balance_date=($2::text::date-1)::text,
      opening_reference=$4,opening_book_balance=$5::numeric::text,
      setup_revision=setup_revision+1,updated_at=now() WHERE id=$1
      RETURNING id,review_start_date,opening_bank_balance,opening_balance_date,
        opening_reference,opening_book_balance,setup_revision`,
    [accountId, body.review_start_date, body.opening_bank_balance, body.opening_reference, body.opening_book_balance ?? null]);
    await applyRulesForAccounts(client, [accountId], actorId);
    return { account: result.rows[0] };
  });
}
