import { getDbPool } from "../../api/utils/db-pool";

import { saveAccounts } from "./accounts";
import { fetchFeedBatch } from "./feed";
import { bankingLimits, limitCode } from "./limits";
import { nullableString, object, plaidRequest } from "./plaid";
import {
  BankingError,
  bankingErrorCode,
  decryptBankToken,
  requireBankingEnabled,
  bankingTokenKey,
  bankingEnvSql,
} from "./security";
import { bankId, connectionRow, transaction, withBankLock } from "./store";
import { applyFeedBatch } from "./sync-store";

export async function syncBank(
  connectionId: string,
  trigger: "initial" | "manual" | "scheduled" | "webhook" = "scheduled"
): Promise<
  | { status: "awaiting_selection" }
  | {
      status: "synced" | "importing";
      added: number;
      modified: number;
      removed: number;
    }
> {
  const key = bankingTokenKey();
  return withBankLock(connectionId, async (client) => {
    const row = await connectionRow(client, connectionId);
    if (row.status === "disconnected" || !row.access_token_encrypted)
      throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
    if (row.status === "reauth_required")
      throw new BankingError("ITEM_LOGIN_REQUIRED", 409);
    if (row.status === "awaiting_selection")
      return { status: "awaiting_selection" };
    const accessToken = decryptBankToken(
      row.access_token_encrypted,
      connectionId,
      key
    );
    const runId = bankId("bsync");
    await transaction(client, async () => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('banking-sandbox-cap', 7241))"
      );
      const cap = bankingLimits().syncRuns;
      if (cap !== null) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM bank_sync_run"
        );
        if (Number(count.rows[0]?.count) >= cap)
          throw new BankingError(limitCode("RUN"), 409);
      }
      await client.query(
        `UPDATE bank_sync_run SET status='failed',finished_at=now(),error_code='BANKING_SYNC_INTERRUPTED'
        WHERE connection_id=$1 AND status='running'`,
        [connectionId]
      );
      await client.query(
        `INSERT INTO bank_sync_run(id,connection_id,trigger,status,started_at,cursor_before)
        VALUES($1,$2,$3,'running',now(),$4)`,
        [runId, connectionId, trigger, row.cursor]
      );
    });
    try {
      // Capture provider completion BEFORE reading the feed: a refresh finishing
      // after the feed read must not be declared imported by this pass.
      const itemResponse = await plaidRequest("/item/get", {
        access_token: accessToken,
      });
      const item = object(itemResponse.item);
      const providerStatus =
        itemResponse.status == null ? null : object(itemResponse.status);
      const transactionsStatus =
        providerStatus?.transactions == null
          ? null
          : object(providerStatus.transactions);
      const lastProviderUpdate = nullableString(
        transactionsStatus?.last_successful_update
      );
      const accountResponse = await plaidRequest("/accounts/get", {
        access_token: accessToken,
      });
      const batch = await fetchFeedBatch(accessToken, row.cursor);
      const counts = await transaction(client, async () => {
        await saveAccounts(client, connectionId, accountResponse.accounts);
        const result = await applyFeedBatch(client, connectionId, batch);
        await client.query(
          `UPDATE bank_connection SET status='active',consent_expiration_time=$2,
          sync_requested_at=CASE WHEN sync_requested_at IS NOT DISTINCT FROM $3::timestamptz THEN NULL ELSE sync_requested_at END,
          refresh_completed_at=CASE WHEN $4::timestamptz IS NOT NULL AND refresh_requested_at <= $4::timestamptz
            THEN now() ELSE refresh_completed_at END,updated_at=now() WHERE id=$1`,
          [
            connectionId,
            nullableString(item.consent_expiration_time),
            row.sync_requested_at,
            lastProviderUpdate,
          ]
        );
        await client.query(
          `UPDATE bank_sync_run SET status='succeeded',finished_at=now(),cursor_after=$2,
          added_count=$3,modified_count=$4,removed_count=$5,updated_at=now() WHERE id=$1`,
          [runId, batch.cursor, result.added, result.modified, result.removed]
        );
        return result;
      });
      return {
        status:
          batch.initialComplete || row.initial_sync_complete
            ? "synced"
            : "importing",
        ...counts,
      };
    } catch (error) {
      const code = bankingErrorCode(error);
      await client.query(
        `UPDATE bank_sync_run SET status='failed',finished_at=now(),error_code=$2,updated_at=now() WHERE id=$1`,
        [runId, code]
      );
      await client.query(
        `UPDATE bank_connection SET status=$2,last_error_code=$3,updated_at=now() WHERE id=$1`,
        [
          connectionId,
          code === "ITEM_LOGIN_REQUIRED" ? "reauth_required" : "error",
          code,
        ]
      );
      throw error;
    }
  });
}

/** Recovery polls existing Plaid data; it does not charge a /transactions/refresh per tick. */
export async function syncPendingBanks(): Promise<void> {
  requireBankingEnabled();
  const candidates = await getDbPool().query<{
    id: string;
  }>(`SELECT c.id FROM bank_connection c
    WHERE c.environment=${bankingEnvSql()} AND c.deleted_at IS NULL AND c.access_token_encrypted IS NOT NULL
      AND c.status IN ('active','error') AND EXISTS(SELECT 1 FROM bank_account a
        WHERE a.connection_id=c.id AND a.is_selected AND a.is_active)
      AND (c.sync_requested_at IS NOT NULL OR NOT c.historical_sync_complete
        OR (c.refresh_requested_at IS NOT NULL AND
          (c.refresh_completed_at IS NULL OR c.refresh_requested_at>c.refresh_completed_at))
        OR c.last_successful_sync_at IS NULL OR c.last_successful_sync_at < now()-interval '6 hours')
      AND NOT EXISTS(SELECT 1 FROM bank_sync_run s WHERE s.connection_id=c.id AND s.started_at>now()-interval '1 minute')
    ORDER BY c.sync_requested_at NULLS LAST,c.id LIMIT 3`);
  for (const candidate of candidates.rows) {
    try {
      await syncBank(candidate.id);
    } catch (error) {
      console.warn(`[banking] ${bankingErrorCode(error)}`);
    }
  }
}
