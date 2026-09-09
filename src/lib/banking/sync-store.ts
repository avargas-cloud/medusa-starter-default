import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { PoolClient } from "pg";

import { bankingLimits, limitCode } from "./limits";
import { withReviewLock } from "./review-common";
import { applyRulesForAccounts } from "./review-rule-apply";
import { invalidateBankSource } from "./review-source";
import { BankingError, bankingEnvSql } from "./security";

export type FeedTransaction = {
  transaction_id: string;
  account_id: string;
  pending_transaction_id: string | null;
  amount: string;
  currency: string | null;
  unofficial_currency: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  source: Record<string, unknown>;
};

export type FeedBatch = {
  added: FeedTransaction[];
  modified: FeedTransaction[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  cursor: string;
  initialComplete: boolean;
  historicalComplete: boolean;
};

type StoredTransaction = {
  id: string;
  account_id: string;
  provider_transaction_id: string;
  pending_transaction_id: string | null;
  amount: string;
  currency: string | null;
  unofficial_currency: string | null;
  status: "pending" | "posted" | "removed";
  transaction_date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  source_data: Record<string, unknown>;
};

/**
 * Persist a complete pagination result. Caller owns BEGIN/COMMIT/ROLLBACK and
 * serialization per connection; throwing requires rolling back the WHOLE batch.
 * Account selection is only a display preference, never an ingestion filter.
 */
export async function applyFeedBatch(
  client: PoolClient,
  connectionId: string,
  batch: FeedBatch
): Promise<{ added: number; modified: number; removed: number }> {
  await withReviewLock(client);
  // The 2,000-row sandbox ceiling is shared across connections: a connection
  // lock alone cannot prevent two concurrent batches from exceeding it.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('banking:sandbox-transaction-cap'))"
  );
  const accounts = await client.query<{
    id: string;
    provider_account_id: string;
  }>(
    `SELECT id, provider_account_id FROM bank_account
       WHERE connection_id = $1 AND deleted_at IS NULL`,
    [connectionId]
  );
  const accountIds = new Map(
    accounts.rows.map((account) => [account.provider_account_id, account.id])
  );
  const stored = await client.query<StoredTransaction>(
    `SELECT id, account_id, provider_transaction_id, pending_transaction_id,
            amount, currency, unofficial_currency, status, transaction_date,
            authorized_date, name, merchant_name, source_data
       FROM bank_transaction WHERE connection_id = $1 FOR UPDATE`,
    [connectionId]
  );
  const transactions = new Map(
    stored.rows.map((row) => [row.provider_transaction_id, row])
  );
  const counts = { added: 0, modified: 0, removed: 0 };
  const finalRemovals = new Set(batch.removed.map((row) => row.transaction_id));
  for (const row of stored.rows) {
    if (row.status === "posted" && row.pending_transaction_id)
      finalRemovals.add(row.pending_transaction_id);
  }
  for (const row of [...batch.added, ...batch.modified]) {
    if (!row.pending && row.pending_transaction_id)
      finalRemovals.add(row.pending_transaction_id);
  }

  function accountId(providerId: string): string {
    const id = accountIds.get(providerId);
    if (!id) throw new BankingError("BANKING_ACCOUNT_MISSING", 409);
    return id;
  }

  async function upsert(tx: FeedTransaction): Promise<void> {
    const resolvedAccount = accountId(tx.account_id);
    const previous = transactions.get(tx.transaction_id);
    if (previous && previous.account_id !== resolvedAccount) {
      throw new BankingError("BANKING_TRANSACTION_ACCOUNT_MISMATCH", 409);
    }
    // A stale pending observation must not downgrade an already-posted row.
    if (previous?.status === "posted" && tx.pending) return;
    const next: StoredTransaction = {
      id: previous?.id ?? `btxn_${randomUUID()}`,
      account_id: resolvedAccount,
      provider_transaction_id: tx.transaction_id,
      pending_transaction_id: tx.pending_transaction_id,
      amount: tx.amount,
      currency: tx.currency,
      unofficial_currency: tx.unofficial_currency,
      status: tx.pending ? "pending" : "posted",
      transaction_date: tx.date,
      authorized_date: tx.authorized_date,
      name: tx.name,
      merchant_name: tx.merchant_name,
      source_data: tx.source,
    };
    const identical = previous && isDeepStrictEqual(previous, next);
    const removedReplay =
      previous?.status === "removed" &&
      finalRemovals.has(tx.transaction_id) &&
      isDeepStrictEqual({ ...previous, status: next.status }, next);
    if (previous && (identical || removedReplay)) {
      await client.query(
        "UPDATE bank_transaction SET last_seen_at = now() WHERE id = $1 AND connection_id = $2",
        [previous.id, connectionId]
      );
      return;
    }
    if (!previous) {
      await client.query(
        `INSERT INTO bank_transaction
          (id, connection_id, account_id, provider_transaction_id, pending_transaction_id,
           amount, currency, unofficial_currency, status, transaction_date, authorized_date,
           name, merchant_name, source_data, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now(),now())`,
        [
          next.id,
          connectionId,
          next.account_id,
          next.provider_transaction_id,
          next.pending_transaction_id,
          next.amount,
          next.currency,
          next.unofficial_currency,
          next.status,
          next.transaction_date,
          next.authorized_date,
          next.name,
          next.merchant_name,
          JSON.stringify(next.source_data),
        ]
      );
      counts.added++;
    } else {
      await client.query(
        `UPDATE bank_transaction SET
           source_revisions = source_revisions || jsonb_build_array(jsonb_build_object(
             'source_data', source_data, 'status', status, 'recorded_at', updated_at,
             'superseded_at', now())),
           pending_transaction_id = $3, amount = $4, currency = $5,
           unofficial_currency = $6, status = $7, transaction_date = $8,
           authorized_date = $9, name = $10, merchant_name = $11,
           source_data = $12::jsonb, removed_at = NULL, deleted_at = NULL,
           source_version=source_version+1,last_seen_at = now(), updated_at = now()
         WHERE id = $1 AND connection_id = $2`,
        [
          next.id,
          connectionId,
          next.pending_transaction_id,
          next.amount,
          next.currency,
          next.unofficial_currency,
          next.status,
          next.transaction_date,
          next.authorized_date,
          next.name,
          next.merchant_name,
          JSON.stringify(next.source_data),
        ]
      );
      counts.modified++;
    }
    await invalidateBankSource(
      client,
      next.id,
      previous?.transaction_date ?? null,
      next.transaction_date
    );
    transactions.set(tx.transaction_id, next);
  }

  async function remove(row: StoredTransaction): Promise<void> {
    if (row.status === "removed") return;
    await client.query(
      `UPDATE bank_transaction SET
         source_revisions = source_revisions || jsonb_build_array(jsonb_build_object(
           'source_data', source_data, 'status', status, 'recorded_at', updated_at,
           'superseded_at', now())),
         status = 'removed', removed_at = COALESCE(removed_at, now()),
         source_version=source_version+1,last_seen_at = now(), updated_at = now()
       WHERE id = $1 AND connection_id = $2 AND status <> 'removed'`,
      [row.id, connectionId]
    );
    row.status = "removed";
    await invalidateBankSource(
      client,
      row.id,
      row.transaction_date,
      row.transaction_date
    );
    counts.removed++;
  }

  for (const tx of batch.added) await upsert(tx);
  for (const tx of batch.modified) await upsert(tx);

  // Resolve AFTER both arrays so a posted item preceding its pending item in
  // the same batch (or from an earlier sync) cannot leave both counted as live.
  for (const posted of transactions.values()) {
    if (posted.status !== "posted" || !posted.pending_transaction_id) continue;
    const pending = transactions.get(posted.pending_transaction_id);
    if (!pending || pending.status !== "pending") continue;
    if (pending.account_id !== posted.account_id) {
      throw new BankingError("BANKING_PENDING_ACCOUNT_MISMATCH", 409);
    }
    await remove(pending);
  }

  for (const removed of batch.removed) {
    const resolvedAccount = removed.account_id
      ? accountId(removed.account_id)
      : null;
    const row = transactions.get(removed.transaction_id);
    // No source existed locally: there is nothing to delete or fabricate.
    if (!row) continue;
    if (resolvedAccount && row.account_id !== resolvedAccount) {
      throw new BankingError("BANKING_TRANSACTION_ACCOUNT_MISMATCH", 409);
    }
    await remove(row);
  }

  // Count removed evidence as well: removal is not a way around the ingest cap.
  const total = await client.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM bank_transaction"
  );
  const count = total.rows[0]?.count;
  if (count === undefined)
    throw new BankingError("BANKING_TRANSACTION_COUNT_FAILED", 503);
  const cap = bankingLimits().transactions;
  if (cap !== null && BigInt(count) > BigInt(cap))
    throw new BankingError(limitCode("TRANSACTION"), 409);
  await applyRulesForAccounts(
    client,
    accounts.rows.map((row) => row.id)
  );

  const updated = await client.query(
    `UPDATE bank_connection SET cursor = $2,
       initial_sync_complete = initial_sync_complete OR $3::boolean,
       historical_sync_complete = historical_sync_complete OR ($3::boolean AND $4::boolean),
       last_successful_sync_at = CASE WHEN $3::boolean THEN now() ELSE last_successful_sync_at END,
       last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE id = $1 AND environment=${bankingEnvSql()} AND deleted_at IS NULL`,
    [
      connectionId,
      batch.cursor,
      batch.initialComplete,
      batch.historicalComplete,
    ]
  );
  if (updated.rowCount !== 1)
    throw new BankingError("BANKING_CONNECTION_MISSING", 409);
  return counts;
}
