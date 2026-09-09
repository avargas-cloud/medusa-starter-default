import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { DEPOSIT_SELECT_SQL } from "./deposit-projection";
import type { BankDeposit } from "./deposit-types";
import {
  OPENING_ITEM_STALE_SQL,
  openingFundingReservedSql,
} from "./opening-sql";
import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  NO_DIRECT_RESERVATION_SQL,
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
  currency: string;
  source_hash: string;
  fingerprint_version?: 2;
  legacy_source_hash?: string;
  source_type?: "opening_item";
  opening_item_id?: string;
  payment_id?: null;
};
export const DEPOSIT_RECEIPT_SQL = `mp.id,mp.display_id,mp.customer_id,
  COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
  mp.method,to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS date,mp.reference,
  (mp.amount::numeric/100)::numeric(30,2)::text AS amount,upper(mp.currency) AS currency,
  ${PAYMENT_FINGERPRINT_SQL} AS source_hash,2 AS fingerprint_version,${LEGACY_PAYMENT_FINGERPRINT_SQL} AS legacy_source_hash,
  (mp.amount::numeric/100-${depositReservedSql("$2::text")})::numeric(30,2)::text AS available_amount`;
export async function depositAccount(
  client: Reader,
  id: string
): Promise<{ currency: string; review_start_date: string | null }> {
  const result = await client.query<{
    currency: string;
    review_start_date: string | null;
  }>(
    `SELECT upper(a.currency) AS currency,a.review_start_date
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
    JOIN bank_account a ON a.id=d.account_id JOIN bank_connection bc ON bc.id=a.connection_id
    WHERE d.id=$1 AND d.deleted_at IS NULL AND a.deleted_at IS NULL AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()}`,
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
export async function listBankDeposits(input: {
  account_id?: string;
  q?: string;
  status?: string;
}): Promise<{ deposits: BankDeposit[]; count: number }> {
  if (!bankingConfig().enabled) return { deposits: [], count: 0 };
  requireBankingEnabled();
  const result = await getDbPool().query<BankDeposit>(
    `SELECT ${DEPOSIT_SELECT_SQL} FROM bank_deposit d
    JOIN bank_account a ON a.id=d.account_id JOIN bank_connection bc ON bc.id=a.connection_id
    WHERE d.deleted_at IS NULL AND a.deleted_at IS NULL AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()}
      AND ($1::text IS NULL OR d.account_id=$1) AND ($2::text IS NULL OR d.status=$2)
      AND ($3::text='' OR concat_ws(' ',d.reference,d.memo) ILIKE '%'||$3||'%') ORDER BY d.deposit_date DESC,d.id`,
    [input.account_id ?? null, input.status ?? null, input.q ?? ""]
  );
  return { deposits: result.rows, count: result.rows.length };
}
export async function depositCandidates(input: {
  account_id: string;
  q?: string;
  deposit_id?: string;
}): Promise<{ candidates: DepositCandidate[]; count: number }> {
  if (!bankingConfig().enabled) return { candidates: [], count: 0 };
  requireBankingEnabled();
  const pool = getDbPool();
  const account = await depositAccount(pool, input.account_id);
  if (input.deposit_id) await loadBankDeposit(pool, input.deposit_id);
  const result = await pool.query<{
    candidates: DepositCandidate[];
    count: string;
  }>(
    `WITH eligible AS (
    SELECT ${DEPOSIT_RECEIPT_SQL} FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND ${NO_DIRECT_RESERVATION_SQL} AND upper(mp.currency)=$1
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date >= $3::date
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date <= (now() AT TIME ZONE 'America/New_York')::date
  ), normal AS (SELECT id,display_id,customer_id,customer_name,method,date,reference,amount,available_amount,currency,source_hash,fingerprint_version
    FROM eligible WHERE available_amount::numeric>0 AND ($4::text='' OR concat_ws(' ',customer_name,reference,display_id::text) ILIKE '%'||$4||'%')),
  opening AS (SELECT oi.id,oi.original_day AS date,jsonb_build_object('id',oi.id,'opening_item_id',oi.id,
    'source_type','opening_item','payment_id',NULL,'display_id',NULL,'customer_id','',
    'customer_name',COALESCE(NULLIF(oi.description,''),oi.reference),'method','opening_uf',
    'date',oi.original_day,'reference',oi.reference,'amount',(oi.amount_cents::numeric/100)::numeric(30,2)::text,
    'available_amount',((oi.amount_cents::numeric-${openingFundingReservedSql("$2::text")})/100)::numeric(30,2)::text,
    'currency','USD','source_hash',oi.source_hash) AS candidate
    FROM bank_opening_item oi JOIN bank_opening_balance opening_balance ON opening_balance.id=oi.opening_id
    WHERE $1::text='USD' AND opening_balance.status='adopted' AND oi.kind='uf_receipt'
      AND opening_balance.cut_date<=(now() AT TIME ZONE 'America/New_York')::date::text
      AND NOT ${OPENING_ITEM_STALE_SQL} AND oi.amount_cents::numeric>${openingFundingReservedSql("$2::text")}
      AND ($4::text='' OR concat_ws(' ',oi.description,oi.reference,oi.external_key) ILIKE '%'||$4||'%')),
  matching AS (SELECT id,date,to_jsonb(normal) AS candidate FROM normal UNION ALL SELECT id,date,candidate FROM opening)
  SELECT (SELECT COUNT(*)::text FROM matching) AS count,COALESCE((SELECT jsonb_agg(p.candidate ORDER BY p.date,p.id) FROM
    (SELECT id,date,candidate FROM matching ORDER BY date,id LIMIT 50) p),'[]'::jsonb) AS candidates`,
    [
      account.currency,
      input.deposit_id ?? null,
      account.review_start_date,
      input.q ?? "",
    ]
  );
  return {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- single-row aggregate query (COUNT/jsonb_agg, no GROUP BY) always returns exactly one row
    candidates: result.rows[0]!.candidates,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- single-row aggregate query (COUNT/jsonb_agg, no GROUP BY) always returns exactly one row
    count: Number(result.rows[0]!.count),
  };
}
