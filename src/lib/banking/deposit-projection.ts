import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  paymentFingerprintSql,
} from "./payment-evidence";

const PAYMENT_FINGERPRINT_SQL = paymentFingerprintSql("dl.payment_snapshot");

/**
 * Header alias d. Only explicitly recorded banking evidence enters the
 * fingerprint. `opening_item_id` rows are a frozen artifact of the retired
 * `bank_opening_item` feature (kept for the tables that already carried one;
 * nothing writes a new one) — they never drift, so `current_hash` mirrors
 * `recorded_hash`. `manual_reference` rows are the banking-on-gl manual
 * Undeposited-Funds line: no external source to compare against either, the
 * line's own content IS the fact.
 */
export const DEPOSIT_SOURCE_HASH_SQL = `md5(jsonb_build_object('id',d.id,'revision',d.revision,'status',d.status,
  'account_id',d.account_id,'currency',d.currency,'date',d.deposit_date,'reference',d.reference,'memo',d.memo,
  'gross',d.gross_amount,'fee',d.fee_amount,'fee_account',d.fee_account_list_id,'fee_reference',d.fee_reference,
  'net',d.net_amount,'lines',COALESCE((SELECT jsonb_agg(CASE
      WHEN dl.manual_reference IS NOT NULL THEN jsonb_build_object('id',dl.id,'manual_reference',dl.manual_reference,
        'manual_description',dl.manual_description,'amount',dl.amount,'recorded_hash',dl.source_hash,'current_hash',dl.source_hash)
      WHEN dl.opening_item_id IS NOT NULL THEN jsonb_build_object('id',dl.id,'opening_item_id',dl.opening_item_id,'amount',dl.amount,
        'recorded_hash',dl.source_hash,'current_hash',dl.source_hash)
      ELSE jsonb_build_object('id',dl.id,'payment_id',dl.payment_id,
        'amount',dl.amount,'recorded_hash',dl.source_hash,'current_hash',${PAYMENT_FINGERPRINT_SQL}) END ORDER BY dl.id)
    FROM bank_deposit_line dl LEFT JOIN customer_payment mp ON mp.id=dl.payment_id
    WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL),'[]'::jsonb))::text)`;
export const DEPOSIT_STALE_SQL = `(NOT EXISTS(SELECT 1 FROM bank_deposit_line dl WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM bank_deposit_line dl LEFT JOIN customer_payment mp ON mp.id=dl.payment_id
    WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL AND (CASE
      WHEN dl.manual_reference IS NOT NULL THEN false
      WHEN dl.opening_item_id IS NOT NULL THEN false
      ELSE mp.id IS NULL
        OR NOT COALESCE((${DEPOSIT_PAYMENT_ELIGIBLE_SQL}),false) OR upper(mp.currency)<>d.currency
        OR dl.source_hash IS DISTINCT FROM ${PAYMENT_FINGERPRINT_SQL} END)))`;
/**
 * record-deposits-gl-20260915: el depósito posteado es un documento del GL
 * (`source_kind='bank_deposit'`, `source_id=d.id`), no un asiento local de
 * Banking (`kind='deposit'` + `deposit_id`, que en producción nunca existió).
 * Alias del header: d.
 */
export const DEPOSIT_POSTED_SQL = `EXISTS(SELECT 1 FROM bank_journal_entry entry
  WHERE entry.source_kind='bank_deposit' AND entry.source_id=d.id AND entry.kind='document' AND entry.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=entry.id))`;
/** ListID de QB de la cuenta destino: la declarada, o el espejo de la cuenta Plaid. Alias: d. */
export const DEPOSIT_TARGET_LIST_ID_SQL = `COALESCE(d.account_list_id,(SELECT pa.qb_list_id FROM bank_account pa WHERE pa.id=d.account_id))`;
export const DEPOSIT_SELECT_SQL = `d.id,d.number,d.revision,d.status,d.account_id,d.currency,d.deposit_date AS date,
  ${DEPOSIT_TARGET_LIST_ID_SQL} AS account_list_id,
  COALESCE((SELECT qa.full_name FROM qb_account qa WHERE qa.qb_list_id=${DEPOSIT_TARGET_LIST_ID_SQL} AND qa.deleted_at IS NULL LIMIT 1),
    (SELECT pa.name FROM bank_account pa WHERE pa.id=d.account_id),'Bank account') AS account_name,
  d.reference,d.memo,d.gross_amount,d.fee_amount,d.fee_account_list_id,d.fee_reference,d.fee_account_snapshot,d.net_amount,
  d.qb_txn_id,d.qb_synced_at,
  ${DEPOSIT_POSTED_SQL} AS accounting_posted,
  ${DEPOSIT_SOURCE_HASH_SQL} AS source_hash,${DEPOSIT_STALE_SQL} AS stale,
  (SELECT e.details->>'origin' FROM bank_review_event e WHERE e.entity_type='deposit' AND e.entity_id=d.id
    AND e.action='deposit_saved' AND e.details ? 'origin' ORDER BY e.created_at,e.id LIMIT 1) AS origin,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',dl.id,'payment_id',dl.payment_id,
    'payment_display_id',dl.payment_snapshot->'display_id','customer_id',dl.payment_snapshot->>'customer_id',
    'customer_name',dl.payment_snapshot->>'customer_name','method',dl.payment_snapshot->>'method',
    'payment_amount',dl.payment_snapshot->>'amount','amount',dl.amount,'source_hash',dl.source_hash,
    'surcharge_amount',COALESCE(dl.payment_snapshot->>'surcharge_amount','0.00'),
    'card_brand',dl.payment_snapshot->>'card_brand')
    || CASE
      WHEN dl.manual_reference IS NOT NULL THEN jsonb_build_object('source_type','manual','manual',true,
        'reference',dl.manual_reference,'description',dl.manual_description,
        'account_list_id',dl.manual_account_list_id,
        'account_name',(SELECT ma.full_name FROM qb_account ma WHERE ma.qb_list_id=dl.manual_account_list_id AND ma.deleted_at IS NULL LIMIT 1))
      WHEN dl.opening_item_id IS NOT NULL THEN jsonb_build_object('source_type','opening_item',
        'opening_item_id',dl.opening_item_id,'reference',dl.payment_snapshot->>'reference')
      ELSE '{}'::jsonb END ORDER BY dl.id)
    FROM bank_deposit_line dl WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL),'[]'::jsonb) AS lines`;
