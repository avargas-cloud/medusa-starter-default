import { selectedAccountRows, saveAccounts } from "./accounts";
import { BankingError, bankingEnvSql, decryptBankToken, bankingTokenKey, manualRefreshAllowed } from "./security";
import { plaidRequest } from "./plaid";
import { connectionRow, transaction, withBankLock } from "./store";
import { syncBank } from "./sync";
import { getDbPool } from "../../api/utils/db-pool";
import { withReviewLock } from "./review-common";
import { requireUnpostedBankAccount } from "./review-setup";

export async function selectBankAccounts(connectionId: string, accountIds: string[]) {
  if (!accountIds.length || accountIds.length > 10 || new Set(accountIds).size !== accountIds.length) throw new BankingError("BANKING_INVALID_SELECTION");
  await withBankLock(connectionId, async (client) => {
    const row = await connectionRow(client, connectionId);
    if (!row.access_token_encrypted || row.status === "disconnected") throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
    if (row.status === "reauth_required") throw new BankingError("ITEM_LOGIN_REQUIRED", 409);
    await transaction(client, async () => {
      await withReviewLock(client);
      const valid = await client.query(`SELECT id FROM bank_account WHERE connection_id=$1 AND id=ANY($2::text[])
        AND is_active AND deleted_at IS NULL AND type IN ('credit','depository')`, [connectionId, accountIds]);
      if (valid.rowCount !== accountIds.length) throw new BankingError("BANKING_INVALID_SELECTION");
      await client.query("UPDATE bank_account SET is_selected=(id=ANY($2::text[])),updated_at=now() WHERE connection_id=$1", [connectionId, accountIds]);
      await client.query("UPDATE bank_connection SET status='active',sync_requested_at=now(),updated_at=now() WHERE id=$1", [connectionId]);
    });
  });
  // The durable request survives a crash or timeout before this eager first pass.
  return syncBank(connectionId, "initial");
}

export async function refreshBank(connectionId: string) {
  if (!manualRefreshAllowed()) throw new BankingError("BANKING_MANUAL_REFRESH_DISABLED", 403);
  const key = bankingTokenKey();
  await withBankLock(connectionId, async (client) => {
    const row = await connectionRow(client, connectionId);
    if (!row.access_token_encrypted || row.status === "disconnected") throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
    if (row.refresh_requested_at && Date.now() - row.refresh_requested_at.getTime() < 60_000) throw new BankingError("BANKING_REFRESH_COOLDOWN", 429);
    // Plaid can complete the refresh before its HTTP response reaches us. Anchor
    // the request before sending it; stamping afterwards leaves it pending forever.
    const requestedAt = new Date();
    await plaidRequest("/transactions/refresh", { access_token: decryptBankToken(row.access_token_encrypted, connectionId, key) });
    await client.query("UPDATE bank_connection SET refresh_requested_at=$2,sync_requested_at=now(),updated_at=now() WHERE id=$1", [connectionId, requestedAt]);
  });
  // Accepted is not the same as extracted; a subsequent webhook/recovery sync proves completion.
  return { status: "refresh_requested" };
}

export async function reconnectBank(connectionId: string) {
  const key = bankingTokenKey();
  return withBankLock(connectionId, async (client) => {
    const row = await connectionRow(client, connectionId);
    if (!row.access_token_encrypted || row.status === "disconnected") throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
    const response = await plaidRequest("/accounts/get", { access_token: decryptBankToken(row.access_token_encrypted, connectionId, key) });
    await transaction(client, async () => {
      await saveAccounts(client, connectionId, response.accounts);
      await client.query(`UPDATE bank_connection SET
        status=CASE WHEN EXISTS(SELECT 1 FROM bank_account
          WHERE connection_id=$1 AND is_selected AND is_active AND deleted_at IS NULL)
          THEN 'active' ELSE 'awaiting_selection' END,
        pending_disconnect=false,sync_requested_at=now(),
        last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=$1`, [connectionId]);
    });
    return { connection_id: connectionId, accounts: await selectedAccountRows(client, connectionId) };
  });
}

export async function disconnectBank(connectionId: string) {
  const key = bankingTokenKey();
  return withBankLock(connectionId, async (client) => {
    const row = await connectionRow(client, connectionId);
    if (row.status === "disconnected") return { status: "disconnected" };
    if (row.access_token_encrypted) {
      try { await plaidRequest("/item/remove", { access_token: decryptBankToken(row.access_token_encrypted, connectionId, key) }); }
      catch (error) {
        if (!(error instanceof BankingError) || !["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"].includes(error.code)) throw error;
      }
    }
    await transaction(client, async () => {
      await withReviewLock(client);
      await client.query(`UPDATE bank_connection SET status='disconnected',access_token_encrypted=NULL,
        sync_requested_at=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1`, [connectionId]);
      await client.query("UPDATE bank_account SET is_active=false,updated_at=now() WHERE connection_id=$1", [connectionId]);
    });
    return { status: "disconnected" };
  });
}

export async function mapBankAccount(accountId: string, qbListId: string | null) {
  bankingTokenKey();
  const result = await getDbPool().query<{ connection_id: string }>(
    `SELECT a.connection_id FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
     WHERE a.id=$1 AND c.environment=${bankingEnvSql()} AND a.deleted_at IS NULL`, [accountId]);
  const row = result.rows[0];
  if (!row) throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
  return withBankLock(row.connection_id, async (client) => transaction(client, async () => {
    await withReviewLock(client);
    // Shared with account refresh/reactivation: per-connection locks cannot
    // serialize two different connections choosing the same QB account.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('banking-sandbox-cap', 7241))");
    const current = await client.query<{ qb_list_id: string | null }>(
      "SELECT qb_list_id FROM bank_account WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [accountId]);
    if (!current.rows[0]) throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
    if (current.rows[0].qb_list_id !== qbListId) {
      await requireUnpostedBankAccount(client, accountId);
      const closed = await client.query(`SELECT id FROM bank_day_close
        WHERE status='closed' AND deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot->'accounts','[]'::jsonb)) b
            WHERE b->'account'->>'id'=$1) LIMIT 1`, [accountId]);
      if (closed.rowCount) throw new BankingError("BANKING_REOPEN_REQUIRED", 409);
    }
    if (qbListId) {
      const valid = await client.query(`SELECT q.qb_list_id FROM qb_account q JOIN bank_account a ON a.id=$2
        WHERE q.qb_list_id=$1 AND q.is_active AND q.deleted_at IS NULL
        AND q.account_type=CASE WHEN a.type='credit' THEN 'CreditCard' ELSE 'Bank' END`, [qbListId, accountId]);
      if (!valid.rowCount) throw new BankingError("BANKING_INVALID_QB_ACCOUNT");
      const duplicate = await client.query("SELECT id FROM bank_account WHERE qb_list_id=$1 AND id<>$2 AND is_active AND deleted_at IS NULL", [qbListId, accountId]);
      if (duplicate.rowCount) throw new BankingError("BANKING_QB_ACCOUNT_ALREADY_MAPPED", 409);
    }
    await client.query("UPDATE bank_account SET qb_list_id=$2,updated_at=now() WHERE id=$1", [accountId, qbListId]);
    return { account_id: accountId, qb_list_id: qbListId };
  }));
}
