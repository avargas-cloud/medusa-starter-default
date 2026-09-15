import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { DEPOSIT_SELECT_SQL } from "./deposit-projection";
import type { BankDeposit } from "./deposit-types";
import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  DEPOSIT_REFUND_ELIGIBLE_SQL,
  NO_DIRECT_RESERVATION_SQL,
  notInOtherDepositSql,
  PAYMENT_FINGERPRINT_SQL,
  LEGACY_PAYMENT_FINGERPRINT_SQL,
  depositReservedSql,
} from "./payment-evidence";
import {
  bankingConfig,
  BankingError,
  requireBankingEnabled,
  bankingEnvSql,
} from "./security";

type Reader = Pick<PoolClient, "query">;
export type DepositCandidate = {
  id: string;
  display_id: number | null;
  customer_id: string;
  customer_name: string;
  method: string;
  date: string;
  reference: string | null;
  amount: string;
  available_amount: string;
  /** Customer-paid card surcharge (cents/100), 0.00 for non-card receipts.
   * Already folded into `available_amount` — this is for display only. */
  surcharge_amount: string;
  currency: string;
  source_hash: string;
  fingerprint_version?: 2;
  legacy_source_hash?: string;
  source_type?: "opening_item" | "manual";
  opening_item_id?: string;
  manual_reference?: string | null;
  manual_description?: string | null;
  payment_id?: null;
  card_brand: string | null;
};
export const DEPOSIT_RECEIPT_SQL = `mp.id,mp.display_id,mp.customer_id,
  COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
  mp.method,mp.card_brand,to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS date,mp.reference,
  (mp.amount::numeric/100)::numeric(30,2)::text AS amount,upper(mp.currency) AS currency,
  ${PAYMENT_FINGERPRINT_SQL} AS source_hash,2 AS fingerprint_version,${LEGACY_PAYMENT_FINGERPRINT_SQL} AS legacy_source_hash,
  (COALESCE(mp.surcharge_cents,0)::numeric/100)::numeric(30,2)::text AS surcharge_amount,
  ((mp.amount::numeric+COALESCE(mp.surcharge_cents,0))/100-${depositReservedSql("$2::text")})::numeric(30,2)::text AS available_amount`;
/**
 * deposit-surcharge-qb-20260915: a processor-batch card refund as a NEGATIVE
 * candidate — same columns as `DEPOSIT_RECEIPT_SQL`. `amount` and
 * `available_amount` are −refund (or 0 when a live deposit already holds it);
 * `date` = the refund date (`metadata.refund_txn_date`), which is when the
 * processor nets it. Aliases: mp, c. */
export const DEPOSIT_REFUND_SQL = `mp.id,mp.display_id,mp.customer_id,
  COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
  'card_refund'::text AS method,mp.card_brand,
  COALESCE(mp.metadata->>'refund_txn_date',to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD')) AS date,
  'Refund '||COALESCE(mp.reference,'PAY-'||mp.display_id::text) AS reference,
  (-(mp.metadata->>'refund_amount')::numeric/100)::numeric(30,2)::text AS amount,upper(mp.currency) AS currency,
  ${PAYMENT_FINGERPRINT_SQL} AS source_hash,2 AS fingerprint_version,${LEGACY_PAYMENT_FINGERPRINT_SQL} AS legacy_source_hash,
  '0.00'::text AS surcharge_amount,
  (CASE WHEN ${notInOtherDepositSql("$2::text")} THEN -(mp.metadata->>'refund_amount')::numeric/100 ELSE 0 END)::numeric(30,2)::text AS available_amount`;
export async function depositAccount(
  client: Reader,
  id: string
): Promise<{ currency: string; review_start_date: string | null; qb_list_id: string | null }> {
  const result = await client.query<{
    currency: string;
    review_start_date: string | null;
    qb_list_id: string | null;
  }>(
    `SELECT upper(a.currency) AS currency,a.review_start_date,a.qb_list_id
    FROM bank_account a JOIN bank_connection bc ON bc.id=a.connection_id WHERE a.id=$1 AND a.deleted_at IS NULL
    AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()} AND a.type='depository' AND a.currency IS NOT NULL`,
    [id]
  );
  if (!result.rows[0]) throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
  if (!result.rows[0].review_start_date)
    throw new BankingError("BANKING_ACCOUNT_SETUP_REQUIRED", 409);
  return result.rows[0];
}
export async function loadBankDeposit(
  client: Reader,
  id: string
): Promise<BankDeposit> {
  const result = await client.query<BankDeposit>(
    `SELECT ${DEPOSIT_SELECT_SQL} FROM bank_deposit d
    ${DEPOSIT_FROM_JOINS}
    WHERE d.id=$1 AND d.deleted_at IS NULL AND ${DEPOSIT_ENV_SQL}`,
    [id]
  );
  if (!result.rows[0]) throw new BankingError("BANKING_DEPOSIT_NOT_FOUND", 404);
  return result.rows[0];
}
export async function readBankDeposit(
  id: string
): Promise<{ deposit: BankDeposit }> {
  requireBankingEnabled();
  return { deposit: await loadBankDeposit(getDbPool(), id) };
}
/**
 * Page size of Record Deposits. The list carried no LIMIT while it only held
 * a handful of rows; with the 2026 QuickBooks history adopted (~670) each row
 * still costs its projection subqueries, so the page is capped and `count`
 * is the whole matching set (COUNT(*) OVER()).
 */
export const DEPOSIT_LIST_LIMIT = 200;
/** `account_id` may be a Plaid account id OR a QuickBooks ListID (deposits to
 * "Cash Register"/"Cash on Hand" have no Plaid account). */
const DEPOSIT_FROM_JOINS = `LEFT JOIN bank_account ba ON ba.id=d.account_id AND ba.deleted_at IS NULL
    LEFT JOIN bank_connection bc ON bc.id=ba.connection_id AND bc.deleted_at IS NULL
    LEFT JOIN qb_account qa ON qa.qb_list_id=COALESCE(d.account_list_id,ba.qb_list_id) AND qa.deleted_at IS NULL`;
const DEPOSIT_ENV_SQL = `(d.account_id IS NULL OR bc.environment=${bankingEnvSql()})`;
export async function listBankDeposits(input: {
  account_id?: string;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<{ deposits: BankDeposit[]; count: number }> {
  if (!bankingConfig().enabled) return { deposits: [], count: 0 };
  requireBankingEnabled();
  const result = await getDbPool().query<BankDeposit & { total: string }>(
    `SELECT ${DEPOSIT_SELECT_SQL},COUNT(*) OVER() AS total FROM bank_deposit d
    ${DEPOSIT_FROM_JOINS}
    WHERE d.deleted_at IS NULL AND ${DEPOSIT_ENV_SQL}
      AND ($1::text IS NULL OR d.account_id=$1 OR COALESCE(d.account_list_id,ba.qb_list_id)=$1)
      AND ($2::text IS NULL OR d.status=$2)
      AND ($3::text='' OR concat_ws(' ',d.number,d.reference,d.memo,d.qb_txn_id,qa.full_name,ba.name) ILIKE '%'||$3||'%')
      AND ($4::text IS NULL OR d.deposit_date>=$4) AND ($5::text IS NULL OR d.deposit_date<=$5)
    ORDER BY d.deposit_date DESC,d.number DESC NULLS LAST,d.id LIMIT $6`,
    [
      input.account_id ?? null,
      input.status ?? null,
      input.q ?? "",
      input.from ?? null,
      input.to ?? null,
      input.limit ?? DEPOSIT_LIST_LIMIT,
    ]
  );
  const total = Number(result.rows[0]?.total ?? 0);
  return {
    deposits: result.rows.map(({ total: _total, ...row }) => row as BankDeposit),
    count: total,
  };
}
/** Page size of the receipt picker. Pages are keyset on (date,id) — the
 * order the list is shown in — so a receipt deposited between two "Load more"
 * clicks shifts nothing; `count` is the whole matching set and `next` is the
 * cursor of the last row, or null when the page reached the end. */
export const DEPOSIT_CANDIDATES_PAGE = 50;
const CANDIDATE_CURSOR = /^(\d{4}-\d{2}-\d{2})\|(.+)$/;
export async function depositCandidates(input: {
  account_id: string;
  q?: string;
  deposit_id?: string;
  /** `YYYY-MM-DD|<payment id>` of the last row already shown. */
  after?: string;
}): Promise<{ candidates: DepositCandidate[]; count: number; next: string | null }> {
  if (!bankingConfig().enabled) return { candidates: [], count: 0, next: null };
  requireBankingEnabled();
  const pool = getDbPool();
  const account = await depositAccount(pool, input.account_id);
  if (input.deposit_id) await loadBankDeposit(pool, input.deposit_id);
  const cursor = input.after ? CANDIDATE_CURSOR.exec(input.after) : null;
  if (input.after && !cursor) throw new BankingError("BANKING_DEPOSIT_CURSOR_INVALID");
  const result = await pool.query<{
    candidates: DepositCandidate[];
    count: string;
    remaining: string;
  }>(
    `WITH eligible AS (
    SELECT ${DEPOSIT_RECEIPT_SQL} FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND ${NO_DIRECT_RESERVATION_SQL} AND ${notInOtherDepositSql("$2::text")} AND upper(mp.currency)=$1
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date >= $3::date
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date <= (now() AT TIME ZONE 'America/New_York')::date
    UNION ALL
    SELECT ${DEPOSIT_REFUND_SQL} FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE ${DEPOSIT_REFUND_ELIGIBLE_SQL} AND ${notInOtherDepositSql("$2::text")} AND upper(mp.currency)=$1
      AND COALESCE(mp.metadata->>'refund_txn_date',to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD'))::date >= $3::date
      AND COALESCE(mp.metadata->>'refund_txn_date',to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD'))::date <= (now() AT TIME ZONE 'America/New_York')::date
  ), normal AS (SELECT id,display_id,customer_id,customer_name,method,card_brand,date,reference,amount,available_amount,surcharge_amount,currency,source_hash,fingerprint_version
    FROM eligible WHERE available_amount::numeric<>0 AND ($4::text='' OR concat_ws(' ',customer_name,reference,display_id::text) ILIKE '%'||$4||'%')),
  matching AS (SELECT id,date,to_jsonb(normal) AS candidate FROM normal),
  page AS (SELECT id,date,candidate FROM matching WHERE $5::text IS NULL OR (date,id) > ($5::text,$6::text))
  SELECT (SELECT COUNT(*)::text FROM matching) AS count,(SELECT COUNT(*)::text FROM page) AS remaining,
    COALESCE((SELECT jsonb_agg(p.candidate ORDER BY p.date,p.id) FROM
    (SELECT id,date,candidate FROM page ORDER BY date,id LIMIT $7::int) p),'[]'::jsonb) AS candidates`,
    [
      account.currency,
      input.deposit_id ?? null,
      account.review_start_date,
      input.q ?? "",
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      DEPOSIT_CANDIDATES_PAGE,
    ]
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- single-row aggregate query (COUNT/jsonb_agg, no GROUP BY) always returns exactly one row
  const row = result.rows[0]!;
  const last = row.candidates[row.candidates.length - 1];
  return {
    candidates: row.candidates,
    count: Number(row.count),
    next:
      last && Number(row.remaining) > row.candidates.length
        ? `${last.date}|${last.id}`
        : null,
  };
}
