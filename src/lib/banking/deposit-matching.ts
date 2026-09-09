import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { bankingConfig, BankingError, requireBankingSandbox } from "./security";
import { depositAccount, loadBankDeposit } from "./deposit-read";
import { validateDepositFee, validateDepositFunding } from "./deposit-validation";
import { DEPOSIT_SELECT_SQL, DEPOSIT_SOURCE_HASH_SQL, DEPOSIT_STALE_SQL } from "./deposit-projection";
import { depositSourceKey, type BankDeposit } from "./deposit-types";

export const DEPOSIT_MATCH_FROM_SQL = `FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
  JOIN bank_connection bc ON bc.id=a.connection_id JOIN bank_deposit d ON d.account_id=t.account_id
    AND d.currency=upper(t.currency) AND d.net_amount::numeric=-t.amount::numeric`;
export const DEPOSIT_MATCH_VALID_SQL = `t.deleted_at IS NULL AND a.deleted_at IS NULL AND bc.deleted_at IS NULL
  AND bc.environment='sandbox' AND a.type='depository' AND t.status='posted' AND t.amount::numeric<0
  AND NOT EXISTS(SELECT 1 FROM bank_opening_clear claim WHERE claim.transaction_id=t.id AND claim.kind='clear'
    AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=claim.id))
  AND d.deleted_at IS NULL AND d.status='ready' AND NOT ${DEPOSIT_STALE_SQL}
  AND NOT EXISTS(SELECT 1 FROM bank_transaction_review reserved WHERE reserved.matched_deposit_id=d.id
    AND reserved.transaction_id<>t.id AND reserved.status<>'excluded' AND reserved.deleted_at IS NULL)`;
export function assertDepositSourceHash(expected: string | null | undefined, actual: string) {
  if (!expected || !/^[a-f0-9]{32}$/.test(expected) || expected !== actual) {
    throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  }
}
export async function validateMatchedDeposit(client: PoolClient, transactionId: string, depositId: string): Promise<BankDeposit> {
  const deposit = await loadBankDeposit(client, depositId);
  if (deposit.status !== "ready") throw new BankingError("BANKING_DEPOSIT_NOT_READY", 409);
  if (deposit.stale) throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  const valid = await client.query<{ id: string }>(`SELECT d.id ${DEPOSIT_MATCH_FROM_SQL}
    WHERE t.id=$1 AND d.id=$2 AND ${DEPOSIT_MATCH_VALID_SQL} FOR SHARE OF d`, [transactionId, depositId]);
  if (!valid.rows[0]) throw new BankingError("BANKING_DEPOSIT_MATCH_INVALID", 409);
  const account = await depositAccount(client, deposit.account_id);
  await validateDepositFee(client, deposit.fee_amount, deposit.fee_account_list_id, deposit.fee_reference);
  for (const line of [...deposit.lines].sort((a, b) => depositSourceKey(a).localeCompare(depositSourceKey(b)))) {
    await validateDepositFunding(client, line, depositId, deposit.currency, account.review_start_date!,
      deposit.date, line.source_hash);
  }
  // Locks above prevent a payment from changing after validation until this review command commits.
  const current = await loadBankDeposit(client, depositId);
  if (current.stale) throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  return current;
}
export async function transactionDepositCandidates(id: string) {
  if (!bankingConfig().enabled) return { deposits: [], count: 0 };
  requireBankingSandbox();
  const result = await getDbPool().query<BankDeposit>(`SELECT ${DEPOSIT_SELECT_SQL} ${DEPOSIT_MATCH_FROM_SQL}
    WHERE t.id=$1 AND ${DEPOSIT_MATCH_VALID_SQL} ORDER BY abs(d.deposit_date::date-t.transaction_date::date),d.id`, [id]);
  return { deposits: result.rows, count: result.rows.length };
}
export type DepositSuggestion = { transaction_id: string; deposit_count: number;
  best_deposit: { id: string; reference: string; date: string; net_amount: string; source_hash: string } };
export async function depositSuggestions(ids: string[]): Promise<DepositSuggestion[]> {
  if (!ids.length) return [];
  const result = await getDbPool().query<DepositSuggestion>(`WITH ranked AS (SELECT t.id AS transaction_id,
    d.id,d.reference,d.deposit_date AS date,d.net_amount,${DEPOSIT_SOURCE_HASH_SQL} AS source_hash,
    COUNT(*) OVER(PARTITION BY t.id)::integer AS deposit_count,
    ROW_NUMBER() OVER(PARTITION BY t.id ORDER BY abs(d.deposit_date::date-t.transaction_date::date),d.id) AS rank
    ${DEPOSIT_MATCH_FROM_SQL} WHERE t.id=ANY($1::text[]) AND ${DEPOSIT_MATCH_VALID_SQL})
    SELECT transaction_id,deposit_count,jsonb_build_object('id',id,'reference',reference,'date',date,
      'net_amount',net_amount,'source_hash',source_hash) AS best_deposit FROM ranked WHERE rank=1`, [ids]);
  return result.rows;
}
