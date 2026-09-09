/** Leaf SQL contracts. Monetary facts exclude ordinary AR application changes. Aliases: mp / oi. */
export const OPENING_PAYMENT_FINGERPRINT_SQL = `md5(jsonb_build_object(
  'id',mp.id,'amount',mp.amount::numeric,'currency',upper(mp.currency),'customer_id',mp.customer_id,
  'source',mp.source,'type',mp.type,'method',mp.method,'reference',mp.reference,'batch_day',mp.batch_day,
  'status',CASE WHEN mp.status IN ('available','partially_applied','applied') THEN 'available' ELSE mp.status END,
  'received_at',to_char(mp.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
  'deleted',mp.deleted_at IS NOT NULL,'refund_id',mp.medusa_refund_id,
  'qb_import',mp.metadata->'qb_import','qb_source',mp.metadata->'qb_source','qb_kind',mp.qb->'source',
  'sales_receipt',mp.metadata->'is_sales_receipt_payment','pending_sr',COALESCE(mp.metadata->>'qb_sync_status','')='pending_sr',
  'refund_amount',mp.metadata->'refund_amount','terminal_refunded',mp.metadata->'terminal_refunded')::text)`;
export const OPENING_ITEM_STALE_SQL = `(oi.payment_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM customer_payment mp JOIN customer customer_source ON customer_source.id=mp.customer_id
  WHERE mp.id=oi.payment_id AND customer_source.deleted_at IS NULL
    AND ${OPENING_PAYMENT_FINGERPRINT_SQL}=oi.source_snapshot->>'payment_fingerprint'))`;
export const OPENING_ACTIVE_CLEAR_SQL = `SELECT oc.id,oc.transaction_id FROM bank_opening_clear oc WHERE oc.item_id=oi.id
  AND oc.kind='clear' AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=oc.id)`;
export function openingFundingReservedSql(excludeDeposit: "$2::text" | "NULL::text" = "NULL::text") {
  return `COALESCE((SELECT SUM(funding.cents) FROM (
    SELECT consumption.amount_cents::numeric AS cents FROM bank_receipt_consumption consumption
      WHERE consumption.opening_item_id=oi.id
        AND NOT(consumption.origin_kind='deposit' AND consumption.origin_id IS NOT DISTINCT FROM ${excludeDeposit})
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=consumption.entry_id)
    UNION ALL SELECT line.amount::numeric*100 FROM bank_deposit_line line JOIN bank_deposit deposit ON deposit.id=line.deposit_id
      WHERE line.opening_item_id=oi.id AND line.deleted_at IS NULL AND deposit.deleted_at IS NULL AND deposit.status<>'void'
        AND deposit.id IS DISTINCT FROM ${excludeDeposit}
        AND NOT EXISTS(SELECT 1 FROM bank_receipt_consumption consumption WHERE consumption.opening_item_id=oi.id
          AND consumption.origin_kind='deposit' AND consumption.origin_id=deposit.id
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=consumption.entry_id))
    ) funding),0)`;
}
export const OPENING_ITEM_COLUMNS_SQL = `oi.id,oi.opening_id,oi.kind,oi.original_day,oi.amount_cents::float8 AS amount_cents,
  oi.external_key,oi.reference,oi.description,oi.payment_id,oi.evidence_id,oi.source_snapshot,oi.source_hash,
  ${OPENING_ITEM_STALE_SQL} AS stale,
  (SELECT oc.id FROM bank_opening_clear oc WHERE oc.item_id=oi.id AND oc.kind='clear'
    AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=oc.id)) AS clear_id,
  (SELECT oc.transaction_id FROM bank_opening_clear oc WHERE oc.item_id=oi.id AND oc.kind='clear'
    AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=oc.id)) AS transaction_id,
  (SELECT t.source_version FROM bank_opening_clear oc JOIN bank_transaction t ON t.id=oc.transaction_id WHERE oc.item_id=oi.id
    AND oc.kind='clear' AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=oc.id)) AS clear_source_version`;
