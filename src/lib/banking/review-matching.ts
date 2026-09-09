import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { bankingConfig, BankingError, requireBankingEnabled, bankingEnvSql } from "./security";
import { PAYMENT_ELIGIBLE_SQL, PAYMENT_FINGERPRINT_SQL, LEGACY_PAYMENT_FINGERPRINT_SQL,
  paymentReservedCentsSql, matchesPaymentFingerprint } from "./payment-evidence";

export type MatchSnapshot = {
  id: string; display_id: number | null; customer_id: string; customer_name: string;
  amount: string; currency: string; date: string; method: string; reference: string | null; source_hash: string;
  fingerprint_version: 2; legacy_source_hash?: string;
};
export type MatchInvoice = { id: string; number: string; status: string; applied_amount: string };
export type MatchCandidate = MatchSnapshot & { invoices: MatchInvoice[] };
export const MATCH_SELECT_SQL = `mp.id,mp.display_id,mp.customer_id,
  COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
  (mp.amount::numeric/100)::text AS amount,upper(mp.currency) AS currency,
  to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS date,
  mp.method,mp.reference,${PAYMENT_FINGERPRINT_SQL} AS source_hash,2 AS fingerprint_version,
  ${LEGACY_PAYMENT_FINGERPRINT_SQL} AS legacy_source_hash`;
export const MATCH_FROM_SQL = `FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
  JOIN bank_connection bc ON bc.id=a.connection_id
  JOIN customer_payment mp ON mp.amount::numeric=(-t.amount::numeric)*100 AND upper(mp.currency)=upper(t.currency)
  JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL`;
export const MATCH_VALID_SQL = `t.deleted_at IS NULL AND a.deleted_at IS NULL
  AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()}
  AND a.type='depository' AND t.status='posted' AND t.amount::numeric<0
  AND NOT EXISTS(SELECT 1 FROM bank_opening_clear claim WHERE claim.transaction_id=t.id AND claim.kind='clear'
    AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=claim.id))
  AND ${PAYMENT_ELIGIBLE_SQL} AND ${paymentReservedCentsSql({ transaction: "t.id" })}=0`;

/** Normalize punctuation identically and require whole words, never numeric substrings. */
const NORMALIZED_REFERENCE = "btrim(regexp_replace(upper(COALESCE(mp.reference,'')),'[^A-Z0-9]+',' ','g'))";
const NORMALIZED_BANK_TEXT = "btrim(regexp_replace(upper(concat_ws(' ',t.name,t.merchant_name)),'[^A-Z0-9]+',' ','g'))";
export const MATCH_RANK_FIELDS_SQL = `(length(replace(${NORMALIZED_REFERENCE},' ',''))>=4
  AND position(' ' || ${NORMALIZED_REFERENCE} || ' ' IN ' ' || ${NORMALIZED_BANK_TEXT} || ' ')>0) AS reference_match,
  abs(t.transaction_date::date-(mp.received_at AT TIME ZONE 'America/New_York')::date) AS date_distance`;

export function assertMatchSourceHash(expected: string | null | undefined, actual: string, legacy?: string): void {
  if (!expected || !/^[a-f0-9]{32}$/.test(expected)) throw new BankingError("BANKING_MATCH_SOURCE_HASH_REQUIRED");
  if (!matchesPaymentFingerprint(expected, { source_hash: actual, legacy_source_hash: legacy })) {
    throw new BankingError("BANKING_MATCH_STALE", 409);
  }
}

export async function validateMatchedPayment(client: PoolClient, transactionId: string,
  paymentId: string): Promise<MatchSnapshot> {
  const result = await client.query<MatchSnapshot>(`SELECT ${MATCH_SELECT_SQL} ${MATCH_FROM_SQL}
    WHERE t.id=$1 AND ${MATCH_VALID_SQL} AND mp.id=$2 FOR SHARE OF mp,c`, [transactionId, paymentId]);
  if (!result.rows[0]) throw new BankingError("BANKING_MATCH_INVALID_OR_RESERVED", 409);
  return result.rows[0];
}

export async function matchCandidates(transactionId: string, q: string) {
  if (!bankingConfig().enabled) return { candidates: [], count: 0, supported: false, reason: "BANKING_SANDBOX_ONLY" };
  requireBankingEnabled();
  const pool = getDbPool();
  const scope = await pool.query<{ supported: boolean }>(`SELECT
    (a.type='depository' AND t.status='posted' AND t.amount::numeric<0 AND t.currency IS NOT NULL) AS supported
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection bc ON bc.id=a.connection_id
    WHERE t.id=$1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()}`, [transactionId]);
  if (!scope.rows[0]) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
  if (!scope.rows[0].supported) return { candidates: [], count: 0, supported: false, reason: "BANKING_MATCH_DIRECT_RECEIPTS_ONLY" };
  const result = await pool.query<{ candidates: MatchCandidate[]; count: string }>(`WITH eligible AS (
    SELECT ${MATCH_SELECT_SQL},${MATCH_RANK_FIELDS_SQL} ${MATCH_FROM_SQL} WHERE t.id=$1 AND ${MATCH_VALID_SQL}
  ), matching AS (SELECT id,display_id,customer_id,customer_name,amount,currency,date,method,reference,source_hash,fingerprint_version,
      reference_match,date_distance
    FROM eligible WHERE $2::text='' OR concat_ws(' ',customer_name,reference,display_id::text) ILIKE '%' || $2 || '%'),
  page AS (SELECT id,display_id,customer_id,customer_name,amount,currency,date,method,reference,source_hash,fingerprint_version,
      reference_match,date_distance
    FROM matching ORDER BY reference_match DESC,date_distance,id LIMIT 50),
  invoice_applications AS (
    SELECT pa.payment_id,i.id,i.invoice_number AS number,i.status,(SUM(pa.amount_applied::numeric)/100)::text AS applied_amount
    FROM payment_application pa JOIN page p ON p.id=pa.payment_id
    JOIN pos_invoice i ON i.id=pa.invoice_id AND i.customer_id=p.customer_id
      AND i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
    WHERE pa.deleted_at IS NULL AND pa.voided_at IS NULL AND pa.amount_applied::numeric>0
    GROUP BY pa.payment_id,i.id,i.invoice_number,i.status
  ), invoice_context AS (
    SELECT payment_id,jsonb_agg(jsonb_build_object('id',id,'number',number,'status',status,
      'applied_amount',applied_amount) ORDER BY number,id) AS invoices
    FROM invoice_applications GROUP BY payment_id
  )
  SELECT (SELECT COUNT(*)::text FROM matching) AS count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'display_id',p.display_id,
      'customer_id',p.customer_id,'customer_name',p.customer_name,'amount',p.amount,'currency',p.currency,
      'date',p.date,'method',p.method,'reference',p.reference,'source_hash',p.source_hash,'fingerprint_version',p.fingerprint_version,
      'invoices',COALESCE(ic.invoices,'[]'::jsonb)) ORDER BY p.reference_match DESC,p.date_distance,p.id)
      FROM page p LEFT JOIN invoice_context ic ON ic.payment_id=p.id),'[]'::jsonb) AS candidates`, [transactionId, q]);
  return { candidates: result.rows[0]!.candidates, count: Number(result.rows[0]!.count), supported: true };
}
