import type { PoolClient } from "pg";

import {
  receiptAccounts,
  receiptMapping,
  receiptSetup,
} from "./receipts-setup";
import { BankingError, requireBankingEnabled } from "./security";

type ClearMapping = {
  account_id: string;
  qb_list_id: string | null;
  currency: string | null;
  type: string;
  is_active: boolean;
  is_selected: boolean;
  deleted: boolean;
  environment: string;
};
/** Resolve the transaction's effective feed account, so reconnecting preserves the stable book identity. */
export async function assertOpeningClearMapping(
  client: PoolClient,
  transactionId: string,
  expectedListId: string
): Promise<void> {
  const row = (
    await client.query<ClearMapping>(
      `SELECT a.id AS account_id,a.qb_list_id,a.currency,a.type,a.is_active,a.is_selected,
    (t.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS deleted,c.environment
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.id=$1 FOR SHARE OF t,a,c`,
      [transactionId]
    )
  ).rows[0];
  if (
    !row ||
    row.deleted ||
    // The feed row must belong to the environment this process serves; a literal "sandbox" here made every
    // production clear fail with MAPPING_STALE (found by guided-review case 13, 2026-09-10).
    row.environment !== requireBankingEnabled() ||
    !row.is_active ||
    !row.is_selected ||
    row.currency !== "USD" ||
    row.type !== "depository" ||
    row.qb_list_id !== expectedListId
  ) {
    throw new BankingError("BANKING_OPENING_MAPPING_STALE", 409);
  }
  const live = (await receiptAccounts(client, [expectedListId]))[0];
  const account = live
    ? receiptMapping(live, (await receiptSetup(client))?.attested === true)
    : null;
  if (
    !account ||
    account.id !== expectedListId ||
    account.account_type !== "Bank" ||
    account.currency !== "USD"
  ) {
    throw new BankingError("BANKING_OPENING_MAPPING_STALE", 409);
  }
}
