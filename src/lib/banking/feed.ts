import { BankingError } from "./security";
import { bankingLimits, limitCode } from "./limits";
import { date, decimal, nullableString, object, plaidRequest, string } from "./plaid";
import type { FeedBatch, FeedTransaction } from "./sync-store";

export function feedTransaction(value: unknown): FeedTransaction {
  const row = object(value);
  if (typeof row.pending !== "boolean") throw new BankingError("BANKING_INVALID_TRANSACTION", 502);
  return {
    transaction_id: string(row.transaction_id), account_id: string(row.account_id),
    pending_transaction_id: nullableString(row.pending_transaction_id), amount: decimal(row.amount),
    currency: nullableString(row.iso_currency_code), unofficial_currency: nullableString(row.unofficial_currency_code),
    date: date(row.date), authorized_date: row.authorized_date == null ? null : date(row.authorized_date),
    name: string(row.name), merchant_name: nullableString(row.merchant_name), pending: row.pending,
    source: row,
  };
}

type Request = typeof plaidRequest;
/** A pagination restart discards the whole uncommitted batch and its new cursors. */
export async function fetchFeedBatch(accessToken: string, originalCursor: string | null, request: Request = plaidRequest): Promise<FeedBatch> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const batch: FeedBatch = { added: [], modified: [], removed: [], cursor: originalCursor || "",
      initialComplete: false, historicalComplete: false };
    // Reset with the batch on mutation: previously traversed cursors may be
    // returned legitimately when a restarted traversal reads the fresh feed.
    const seenCursors = new Set([batch.cursor]);
    try {
      for (let page = 0; page < 100; page++) {
        const response = await request("/transactions/sync", {
          access_token: accessToken, ...(batch.cursor ? { cursor: batch.cursor } : {}),
          count: 500, options: { include_original_description: true },
        });
        if (!Array.isArray(response.added) || !Array.isArray(response.modified) || !Array.isArray(response.removed) ||
            typeof response.has_more !== "boolean" || typeof response.next_cursor !== "string") {
          throw new BankingError("BANKING_PROVIDER_INVALID_RESPONSE", 502);
        }
        batch.added.push(...response.added.map(feedTransaction));
        batch.modified.push(...response.modified.map(feedTransaction));
        batch.removed.push(...response.removed.map((value: unknown) => {
          const row = object(value);
          const accountId = nullableString(row.account_id);
          if (accountId !== null && !accountId.trim()) throw new BankingError("BANKING_PROVIDER_INVALID_RESPONSE", 502);
          return { transaction_id: string(row.transaction_id), ...(accountId !== null ? { account_id: accountId } : {}) };
        }));
        if (batch.added.length + batch.modified.length + batch.removed.length > bankingLimits().batch) {
          throw new BankingError(limitCode("BATCH"), 409);
        }
        batch.cursor = response.next_cursor;
        batch.historicalComplete = response.transactions_update_status === "HISTORICAL_UPDATE_COMPLETE";
        batch.initialComplete = batch.historicalComplete || response.transactions_update_status === "INITIAL_UPDATE_COMPLETE";
        if (!response.has_more) return batch;
        if (!batch.cursor || seenCursors.has(batch.cursor)) throw new BankingError("BANKING_CURSOR_NOT_ADVANCING", 502);
        seenCursors.add(batch.cursor);
      }
      throw new BankingError("BANKING_PAGE_LIMIT_REACHED", 409);
    } catch (error) {
      if (!(error instanceof BankingError) || error.code !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" || attempt === 2) throw error;
    }
  }
  throw new BankingError("BANKING_SYNC_RETRY_EXHAUSTED", 502);
}
