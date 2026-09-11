/** Monetary receipt evidence shared by direct matching and grouped deposits. Alias: mp. */
export const LEGACY_PAYMENT_FINGERPRINT_SQL = `md5(jsonb_build_object(
  'id',mp.id,'amount',mp.amount::numeric,'currency',upper(mp.currency),'status',mp.status,
  'customer_id',mp.customer_id,'method',mp.method,'reference',mp.reference,
  'received_at',to_char(mp.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
  'qb_import',mp.metadata->>'qb_import','deleted',mp.deleted_at IS NOT NULL)::text)`;
export const PAYMENT_APPLICATION_STATUSES = [
  "available",
  "partially_applied",
  "applied",
] as const;
export function paymentEconomicStatus(status: string): string {
  return (PAYMENT_APPLICATION_STATUSES as readonly string[]).includes(status)
    ? "available"
    : status;
}
/** Only ordinary AR application states are equivalent; void/refund remain economic drift. */
export const PAYMENT_FINGERPRINT_SQL = LEGACY_PAYMENT_FINGERPRINT_SQL.replace(
  "'status',mp.status",
  `'fingerprint_version',2,'status',CASE WHEN mp.status IN (${PAYMENT_APPLICATION_STATUSES.map((value) => `'${value}'`).join(",")}) THEN 'available' ELSE mp.status END`
);
/** A stored snapshot without a version keeps its original comparison; never rewrite closed evidence. */
export function paymentFingerprintSql(
  snapshotSql: "dl.payment_snapshot" | "r.match_snapshot"
): string {
  return `(CASE WHEN ${snapshotSql}->>'fingerprint_version'='2' THEN ${PAYMENT_FINGERPRINT_SQL} ELSE ${LEGACY_PAYMENT_FINGERPRINT_SQL} END)`;
}
export function matchesPaymentFingerprint(
  expected: string,
  payment: { source_hash: string; legacy_source_hash?: string }
): boolean {
  return (
    expected === payment.source_hash || expected === payment.legacy_source_hash
  );
}
export const PAYMENT_ELIGIBLE_SQL = `mp.deleted_at IS NULL AND mp.type='payment'
  AND mp.method IN ('ach','zelle','check') AND mp.status IN ('available','partially_applied','applied')
  AND mp.amount::numeric>0 AND COALESCE(mp.metadata->>'qb_import','false')='false'`;
export const DEPOSIT_PAYMENT_ELIGIBLE_SQL =
  PAYMENT_ELIGIBLE_SQL.replace(
    "('ach','zelle','check')",
    "('cash','ach','zelle','check')"
  ) + " AND mp.amount::numeric=trunc(mp.amount::numeric)";
export const NO_DIRECT_RESERVATION_SQL = `NOT EXISTS(SELECT 1 FROM bank_transaction_review dr
  WHERE dr.matched_payment_id=mp.id AND dr.status<>'excluded' AND dr.deleted_at IS NULL)`;
export const NO_DEPOSIT_RESERVATION_SQL = `NOT EXISTS(SELECT 1 FROM bank_deposit_line dl
  JOIN bank_deposit d ON d.id=dl.deposit_id WHERE dl.payment_id=mp.id AND dl.deleted_at IS NULL
  AND d.deleted_at IS NULL AND d.status<>'void')`;
/** mp is the source payment. Exclusions are caller-owned expressions, never request text.
 * Posted claims survive unmatch. An operational reservation and its posting are one intent.
 * All availability writers must hold the existing banking-review transaction lock. */
export function paymentReservedCentsSql(
  exclude: {
    deposit?: "$2::text" | "NULL::text";
    transaction?: "$3::text" | "t.id" | "NULL::text";
  } = {}
): string {
  const deposit = exclude.deposit ?? "NULL::text";
  const transaction = exclude.transaction ?? "NULL::text";
  const active = `NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=claim.entry_id)`;
  return `COALESCE((SELECT SUM(reservation.amount_cents) FROM (
    SELECT claim.amount_cents::numeric FROM bank_receipt_consumption claim
      WHERE claim.payment_id=mp.id AND ${active}
        AND NOT(claim.origin_kind='deposit' AND claim.origin_id IS NOT DISTINCT FROM ${deposit})
        AND NOT(claim.origin_kind='payment_match' AND claim.origin_id IS NOT DISTINCT FROM ${transaction})
    UNION ALL
    SELECT dl.amount::numeric*100 FROM bank_deposit_line dl JOIN bank_deposit d ON d.id=dl.deposit_id
      WHERE dl.payment_id=mp.id AND dl.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status<>'void'
        AND d.id IS DISTINCT FROM ${deposit}
        AND NOT EXISTS(SELECT 1 FROM bank_receipt_consumption claim WHERE claim.payment_id=mp.id
          AND claim.origin_kind='deposit' AND claim.origin_id=d.id AND ${active})
    UNION ALL
    SELECT mp.amount::numeric FROM bank_transaction_review reservation
      WHERE reservation.matched_payment_id=mp.id AND reservation.status<>'excluded' AND reservation.deleted_at IS NULL
        AND reservation.transaction_id IS DISTINCT FROM ${transaction}
        AND NOT EXISTS(SELECT 1 FROM bank_receipt_consumption claim WHERE claim.payment_id=mp.id
          AND claim.origin_kind='payment_match' AND claim.origin_id=reservation.transaction_id AND ${active})
    ) reservation),0)`;
}
/** Backwards-compatible major-unit projection for deposit readers. */
export function depositReservedSql(
  excludeSql: "$2::text" | "NULL::text"
): string {
  return `(${paymentReservedCentsSql({ deposit: excludeSql })}/100)`;
}
