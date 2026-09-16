/**
 * Read-only: for each active production connection, print Plaid's own view of the Item
 * (`/item/get` → status.transactions.last_successful_update / last_failed_update, item.error,
 * item.webhook, consent_expiration_time). Never prints the access token.
 * Run inside the prod wrapper of .claude/skills/bank-reconcile (railway run … tsx).
 */
import { getDbPool } from "../../api/utils/db-pool";
import { object, plaidRequest, nullableString } from "../../lib/banking/plaid";
import { bankingEnvSql, bankingTokenKey, decryptBankToken } from "../../lib/banking/security";

async function main(): Promise<void> {
  const key = bankingTokenKey();
  const pool = getDbPool();
  const rows = await pool.query<{ id: string; institution_name: string; access_token_encrypted: string }>(
    `SELECT id,institution_name,access_token_encrypted FROM bank_connection
     WHERE environment=${bankingEnvSql()} AND deleted_at IS NULL AND access_token_encrypted IS NOT NULL
       AND status IN ('active','error','reauth_required') ORDER BY institution_name`
  );
  for (const row of rows.rows) {
    const token = decryptBankToken(row.access_token_encrypted, row.id, key);
    const res = await plaidRequest("/item/get", { access_token: token });
    const item = object(res.item);
    const tx = res.status == null ? null : object(object(res.status).transactions);
    const err = item.error && typeof item.error === "object" ? object(item.error) : null;
    console.log(JSON.stringify({
      inst: row.institution_name,
      last_successful_update: nullableString(tx?.last_successful_update),
      last_failed_update: nullableString(tx?.last_failed_update),
      error_code: err ? nullableString(err.error_code) : null,
      error_message: err ? nullableString(err.error_message) : null,
      webhook: nullableString(item.webhook),
      consent_expiration_time: nullableString(item.consent_expiration_time),
      products: item.products, billed_products: item.billed_products,
      update_type: nullableString(item.update_type),
    }));
  }
  await pool.end();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
