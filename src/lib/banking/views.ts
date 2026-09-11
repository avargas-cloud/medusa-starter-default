import { getDbPool } from "../../api/utils/db-pool";

import { readBankingControl } from "./control";
import { journalClaimProjection } from "./journal-claim";
import { REVIEW_JOINS, REVIEW_SELECT_SQL } from "./review-projection";
import type { Review } from "./review-types";
import {
  bankingConfig,
  BankingError,
  requireBankingEnabled,
  bankingEnvSql,
  manualRefreshAllowed,
} from "./security";

export interface BankConnectionView {
  id: string;
  institution_name: string;
  status: string;
  last_synced_at: Date | null;
  last_error: string | null;
  history_complete: boolean;
  pending_disconnect: boolean;
  consent_expiration_time: Date | null;
  refresh_request_pending: boolean;
}

export interface BankAccountView {
  id: string;
  connection_id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string | null;
  is_active: boolean;
  selected: boolean;
  qb_list_id: string | null;
  current_balance: string | null;
  available_balance: string | null;
  review_start_date: string | null;
  opening_bank_balance: string | null;
  opening_balance_date: string | null;
  opening_reference: string | null;
  opening_book_balance: string | null;
  setup_revision: number;
}

export interface BankTransactionView {
  id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: string;
  currency: string | null;
  status: "pending" | "posted" | "removed";
  source_version: number;
  review: Review | null;
  review_status: "pending" | "confirmed" | "excluded" | "closed";
  attachment_count: number;
  day_closed: boolean;
  stale: boolean;
  opening_clear?: { id: string; item_id: string; reference: string };
}

/** Explicit DTOs keep provider payloads, cursors and token material server-side. */
export async function bankingOverview(
  canManage: boolean,
  canReview = canManage,
  canClose = canManage
): Promise<{
  config: {
    enabled: boolean;
    environment: "sandbox" | "production";
    unavailable_reason: string | null;
    config_error: string | null;
    can_manage: boolean;
    can_review: boolean;
    can_close: boolean;
    control_enabled: boolean;
    manual_refresh: boolean;
  };
  connections: BankConnectionView[];
  accounts: BankAccountView[];
}> {
  const base = {
    ...bankingConfig(),
    can_manage: canManage,
    can_review: canReview,
    can_close: canClose,
  };
  if (!base.enabled)
    return {
      config: { ...base, control_enabled: false, manual_refresh: false },
      connections: [],
      accounts: [],
    };
  requireBankingEnabled();
  const pool = getDbPool();
  const config = {
    ...base,
    control_enabled: (await readBankingControl(pool)).enabled,
    manual_refresh: manualRefreshAllowed(),
  };
  const [connections, accounts] = await Promise.all([
    pool.query<BankConnectionView>(
      `SELECT id, COALESCE(institution_name, 'Bank connection') AS institution_name,
              status, last_successful_sync_at AS last_synced_at,
              CASE WHEN last_error_code ~ '^[A-Z0-9_]{1,80}$'
                   THEN last_error_code
                   WHEN last_error_code IS NOT NULL THEN 'BANKING_OPERATION_FAILED'
                   ELSE NULL END AS last_error,
              historical_sync_complete AS history_complete,
              pending_disconnect, consent_expiration_time,
              (refresh_requested_at IS NOT NULL AND
               (refresh_completed_at IS NULL OR refresh_requested_at > refresh_completed_at))
                AS refresh_request_pending
         FROM bank_connection
        WHERE deleted_at IS NULL AND environment=${bankingEnvSql()}
        ORDER BY created_at, id`
    ),
    pool.query<BankAccountView>(
      `SELECT a.id, a.connection_id, a.name, a.mask, a.type, a.subtype,
              a.currency, a.is_active, a.is_selected AS selected, a.qb_list_id,
              a.balances->>'current' AS current_balance,
              a.balances->>'available' AS available_balance,
              a.review_start_date,a.opening_bank_balance,a.opening_balance_date,
              a.opening_reference,a.opening_book_balance,a.setup_revision
         FROM bank_account a
         JOIN bank_connection c ON c.id = a.connection_id
        WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL
          AND c.environment=${bankingEnvSql()}
        ORDER BY a.connection_id, a.name, a.id`
    ),
  ]);
  return { config, connections: connections.rows, accounts: accounts.rows };
}

export interface TransactionFilters {
  account_id: string;
  status?: BankTransactionView["status"];
  offset: number;
  limit: number;
  review_status?: "all" | "pending" | "confirmed" | "excluded" | "closed";
  q?: string;
  date_from?: string;
  date_to?: string;
  history?: boolean;
}

/** Count and page share one Postgres statement snapshot, including empty pages. */
export async function bankingTransactions(
  filters: TransactionFilters
): Promise<{
  transactions: Array<
    BankTransactionView & {
      opening_clear?: { id: string; item_id: string; reference: string };
    }
  >;
  count: number;
}> {
  if (!bankingConfig().enabled) return { transactions: [], count: 0 };
  requireBankingEnabled();
  const result = await getDbPool().query<{
    account_exists: boolean;
    count: string;
    transactions: BankTransactionView[];
  }>(
    `WITH account_scope AS (
       SELECT a.id,a.review_start_date FROM bank_account a
         JOIN bank_connection c ON c.id = a.connection_id
        WHERE a.id = $1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL
          AND c.environment=${bankingEnvSql()}
     ), projected AS NOT MATERIALIZED (
       SELECT ${REVIEW_SELECT_SQL}
         FROM bank_transaction t
         JOIN account_scope a ON a.id = t.account_id
         ${REVIEW_JOINS}
        WHERE t.deleted_at IS NULL AND ($2::text IS NULL OR t.status = $2::text)
          AND ($5::boolean OR t.transaction_date>=COALESCE(a.review_start_date,'2026-09-01'))
          AND ($6::text IS NULL OR t.transaction_date >= $6::text)
          AND ($7::text IS NULL OR t.transaction_date <= $7::text)
          AND ($8::text='' OR concat_ws(' ',t.name,t.merchant_name,r.comment,r.counterparty_name)
               ILIKE '%' || $8 || '%')
     ), matching AS NOT MATERIALIZED (
       SELECT id,account_id,date,name,merchant_name,amount,currency,status,source_version,
         review,review_status,stale,day_closed,attachment_count FROM projected
       WHERE $9::text='all' OR review_status=$9::text
     ), page AS (
       SELECT id,account_id,date,name,merchant_name,amount,currency,status,source_version,
         review,review_status,stale,day_closed,attachment_count
         FROM matching ORDER BY date DESC, id DESC LIMIT $3 OFFSET $4
     )
     SELECT EXISTS(SELECT 1 FROM account_scope) AS account_exists,
            (SELECT COUNT(*) FROM matching)::text AS count,
            COALESCE((SELECT jsonb_agg(page ORDER BY date DESC, id DESC) FROM page),
                     '[]'::jsonb) AS transactions`,
    [
      filters.account_id,
      filters.status ?? null,
      filters.limit,
      filters.offset,
      filters.history ?? false,
      filters.date_from ?? null,
      filters.date_to ?? null,
      filters.q ?? "",
      filters.review_status ?? "all",
    ]
  );
  const row = result.rows[0];
  if (!row?.account_exists)
    throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
  const count = Number(row.count);
  if (!Number.isSafeInteger(count))
    throw new BankingError("BANKING_COUNT_INVALID", 500);
  return {
    transactions: await journalClaimProjection(getDbPool(), row.transactions),
    count,
  };
}
