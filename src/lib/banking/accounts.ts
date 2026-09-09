import type { PoolClient } from "pg";
import { BankingError, bankingEnvSql } from "./security";
import { bankingLimits, limitCode } from "./limits";
import { decimal, nullableString, object, string } from "./plaid";
import { bankId } from "./store";
import { withReviewLock } from "./review-common";

export async function saveAccounts(client: PoolClient, connectionId: string, input: unknown) {
  await withReviewLock(client);
  if (!Array.isArray(input)) throw new BankingError("BANKING_INVALID_ACCOUNTS", 502);
  const providerIds: string[] = [];
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('banking-sandbox-cap', 7241))");
  for (const value of input) {
    const row = object(value);
    const providerId = string(row.account_id);
    if (providerIds.includes(providerId)) throw new BankingError("BANKING_DUPLICATE_ACCOUNT", 502);
    providerIds.push(providerId);
    const balance = object(row.balances);
    const persistentId = nullableString(row.persistent_account_id);
    if (persistentId) {
      const existing = await client.query<{ id: string; connection_id: string }>(
        `SELECT a.id,a.connection_id FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
         WHERE a.persistent_account_id=$1 AND c.environment=${bankingEnvSql()} AND c.status <> 'disconnected'`, [persistentId]);
      if (existing.rows.some((account) => account.connection_id !== connectionId)) {
        throw new BankingError("BANKING_DUPLICATE_CONNECTION", 409);
      }
      if (existing.rows.length > 1) throw new BankingError("BANKING_AMBIGUOUS_ACCOUNT", 409);
      if (existing.rows[0]) await client.query(
        "UPDATE bank_account SET provider_account_id=$2,updated_at=now() WHERE id=$1", [existing.rows[0].id, providerId]);
    }
    const balances = {
      current: balance.current == null ? null : decimal(balance.current),
      available: balance.available == null ? null : decimal(balance.available),
      limit: balance.limit == null ? null : decimal(balance.limit),
      iso_currency_code: nullableString(balance.iso_currency_code),
      unofficial_currency_code: nullableString(balance.unofficial_currency_code),
    };
    await client.query(`INSERT INTO bank_account
      (id,connection_id,provider_account_id,persistent_account_id,name,official_name,mask,type,subtype,currency,
       balances,balance_updated_at,source_data,is_active,is_selected)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),$12::jsonb,true,false)
      ON CONFLICT(connection_id,provider_account_id) DO UPDATE SET
        persistent_account_id=EXCLUDED.persistent_account_id,name=EXCLUDED.name,official_name=EXCLUDED.official_name,
        mask=EXCLUDED.mask,type=EXCLUDED.type,subtype=EXCLUDED.subtype,currency=EXCLUDED.currency,
        balances=EXCLUDED.balances,balance_updated_at=now(),source_data=EXCLUDED.source_data,is_active=true,
        updated_at=now(),deleted_at=NULL`, [bankId("bacct"), connectionId, providerId, persistentId,
      string(row.name), nullableString(row.official_name), nullableString(row.mask), string(row.type),
      nullableString(row.subtype), balances.iso_currency_code, JSON.stringify(balances), JSON.stringify(row)]);
  }
  await client.query(`UPDATE bank_account SET is_active=false,updated_at=now()
    WHERE connection_id=$1 AND NOT(provider_account_id=ANY($2::text[]))`, [connectionId, providerIds]);
  const count = await client.query<{ count: string }>("SELECT count(*) FROM bank_account WHERE is_active AND deleted_at IS NULL");
  if (Number(count.rows[0]?.count) > bankingLimits().accounts) throw new BankingError(limitCode("ACCOUNT"), 409);
}

export async function selectedAccountRows(client: PoolClient, connectionId: string) {
  return (await client.query(`SELECT id,connection_id,name,mask,type,subtype,currency,is_selected AS selected,qb_list_id,
    balances->>'current' AS current_balance,balances->>'available' AS available_balance
    FROM bank_account WHERE connection_id=$1 AND is_active=true AND deleted_at IS NULL ORDER BY name,id`, [connectionId])).rows;
}
