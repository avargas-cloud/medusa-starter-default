import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { transaction } from "./store";
import { BankingError, requireBankingSandbox } from "./security";
import { reviewToday } from "./review-date";
import { reviewCapacity, runReviewCommand, withReviewLock } from "./review-common";
import { bankAccountingCurrency, type AccountingAccount } from "./accounting-types";
import { receiptSetupSchema, type ReceiptSetup, type ReceiptSetupContext, type ReceiptSetupInput } from "./receipts-types";

export async function receiptRead<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
  requireBankingSandbox();
  const client = await getDbPool().connect();
  try { return await transaction(client, async () => { await withReviewLock(client); return read(client); }); }
  finally { client.release(); }
}
export function receiptMapping(account: AccountingAccount, attested: boolean): AccountingAccount {
  const known = bankAccountingCurrency(account.account_type, account.currency);
  const local = attested && account.currency === null && ["AccountsReceivable", "OtherCurrentAsset"].includes(account.account_type);
  return { ...account, qb_currency_ref: account.currency, currency: known ?? (local ? "USD" : null) };
}
export async function receiptAccounts(client: PoolClient, ids?: string[]): Promise<AccountingAccount[]> {
  const rows = (await client.query<AccountingAccount>(`SELECT qb_list_id AS id,full_name AS name,account_type,currency
    FROM qb_account WHERE is_active AND deleted_at IS NULL AND ($1::text[] IS NULL OR qb_list_id=ANY($1::text[]))
    AND account_type IN ('AccountsReceivable','OtherCurrentAsset','Bank','Expense','OtherExpense')
    ORDER BY full_name,qb_list_id FOR SHARE`, [ids ?? null])).rows;
  return rows;
}
export async function receiptSetup(client: PoolClient): Promise<ReceiptSetup | null> {
  return (await client.query<ReceiptSetup>(`SELECT id,revision,cut_date,currency,
    ar_account_snapshot AS ar_account,clearing_account_snapshot AS clearing_account,attested,
    (EXISTS(SELECT 1 FROM bank_receipt_accounting) OR EXISTS(SELECT 1 FROM bank_opening_balance WHERE status='adopted')
      OR EXISTS(SELECT 1 FROM bank_journal_entry WHERE kind IN ('movement','merchant_receipt','merchant_settlement')))
      AS frozen FROM bank_accounting_setup WHERE id='local-usd' AND deleted_at IS NULL`)).rows[0] ?? null;
}
export async function receiptSetupContext(client: PoolClient): Promise<ReceiptSetupContext> {
  const accounts = await receiptAccounts(client);
  return { setup: await receiptSetup(client), ar_accounts: accounts.filter(a => a.account_type === "AccountsReceivable")
    .filter(a => receiptMapping(a, true).currency === "USD"),
  clearing_accounts: accounts.filter(a => a.account_type === "OtherCurrentAsset")
    .filter(a => receiptMapping(a, true).currency === "USD"), opening_pending: true, coverage: "partial" };
}
export const readReceiptSetup = () => receiptRead(receiptSetupContext);
export async function saveReceiptSetup(actorId: string, key: string, input: ReceiptSetupInput) {
  const body = receiptSetupSchema.parse(input);
  return runReviewCommand({ actorId, key, operation: "receipt_setup", entityId: "local-usd", body }, async client => {
    const previous = await receiptSetup(client);
    if (previous?.frozen) throw new BankingError("BANKING_RECEIPT_SETUP_FROZEN", 409);
    if ((previous?.revision ?? 0) !== body.expected_revision) throw new BankingError("BANKING_RECEIPT_SETUP_STALE", 409);
    if (body.cut_date > reviewToday()) throw new BankingError("BANKING_RECEIPT_CUT_INVALID", 409);
    const accounts = await receiptAccounts(client, [body.ar_account_list_id, body.clearing_account_list_id]);
    const ar = accounts.find(a => a.id === body.ar_account_list_id);
    const clearing = accounts.find(a => a.id === body.clearing_account_list_id);
    if (!ar || ar.account_type !== "AccountsReceivable" || !clearing || clearing.account_type !== "OtherCurrentAsset"
      || ar.id === clearing.id
      || receiptMapping(ar, true).currency !== "USD" || receiptMapping(clearing, true).currency !== "USD") {
      throw new BankingError("BANKING_RECEIPT_MAPPING_INVALID", 409);
    }
    if (!previous) await reviewCapacity(client, "bank_accounting_setup", 10);
    await client.query(`INSERT INTO bank_accounting_setup
      (id,revision,cut_date,currency,ar_account_list_id,clearing_account_list_id,ar_account_snapshot,clearing_account_snapshot,attested,actor_id)
      VALUES('local-usd',$1,$2,'USD',$3,$4,$5::jsonb,$6::jsonb,true,$7)
      ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,cut_date=EXCLUDED.cut_date,
      ar_account_list_id=EXCLUDED.ar_account_list_id,clearing_account_list_id=EXCLUDED.clearing_account_list_id,
      ar_account_snapshot=EXCLUDED.ar_account_snapshot,clearing_account_snapshot=EXCLUDED.clearing_account_snapshot,
      actor_id=EXCLUDED.actor_id,updated_at=now()`, [body.expected_revision + 1, body.cut_date, ar.id, clearing.id,
      JSON.stringify(receiptMapping(ar, true)), JSON.stringify(receiptMapping(clearing, true)), actorId]);
    return receiptSetupContext(client);
  });
}
