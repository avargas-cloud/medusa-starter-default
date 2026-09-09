import type { PoolClient } from "pg";
import { BankingError } from "./security";
import { receiptAccounts } from "./receipts-setup";
import { bankAccountingCurrency } from "./accounting-types";

type ClearMapping = { account_id: string; qb_list_id: string | null; currency: string | null; type: string;
  is_active: boolean; is_selected: boolean; deleted: boolean; environment: string };
/** Resolve the transaction's effective feed account, so reconnecting preserves the stable book identity. */
export async function assertOpeningClearMapping(client: PoolClient, transactionId: string, expectedListId: string): Promise<void> {
  const row = (await client.query<ClearMapping>(`SELECT a.id AS account_id,a.qb_list_id,a.currency,a.type,a.is_active,a.is_selected,
    (t.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS deleted,c.environment
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.id=$1 FOR SHARE OF t,a,c`, [transactionId])).rows[0];
  if (!row || row.deleted || row.environment !== "sandbox" || !row.is_active || !row.is_selected
    || row.currency !== "USD" || row.type !== "depository" || row.qb_list_id !== expectedListId) {
    throw new BankingError("BANKING_OPENING_MAPPING_STALE", 409);
  }
  const account = (await receiptAccounts(client, [expectedListId]))[0];
  if (!account || account.id !== expectedListId || account.account_type !== "Bank"
    || bankAccountingCurrency(account.account_type, account.currency) !== "USD") {
    throw new BankingError("BANKING_OPENING_MAPPING_STALE", 409);
  }
}
