import {
  DEPOSIT_SOURCE_HASH_SQL,
  DEPOSIT_STALE_SQL,
} from "./deposit-projection";
import {
  PAYMENT_ELIGIBLE_SQL,
  paymentFingerprintSql,
} from "./payment-evidence";
import { REVIEW_JSON, type Review } from "./review-types";

export {
  PAYMENT_ELIGIBLE_SQL,
  PAYMENT_FINGERPRINT_SQL,
} from "./payment-evidence";
export const REVIEW_JOINS = `LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id AND r.deleted_at IS NULL
  LEFT JOIN bank_day_close dc ON dc.day=t.transaction_date AND dc.deleted_at IS NULL
  LEFT JOIN customer_payment mp ON mp.id=r.matched_payment_id
  LEFT JOIN bank_deposit d ON d.id=r.matched_deposit_id`;
export const REVIEW_STALE_SQL = `(r.id IS NOT NULL AND (r.source_version<>t.source_version OR
  (r.mode='match' AND r.matched_payment_id IS NOT NULL AND (
    mp.id IS NULL OR NOT COALESCE((${PAYMENT_ELIGIBLE_SQL}),false)
    OR r.match_snapshot->>'source_hash' IS DISTINCT FROM ${paymentFingerprintSql("r.match_snapshot")})) OR
  (r.mode='deposit' AND r.matched_deposit_id IS NOT NULL AND (d.id IS NULL OR d.status<>'ready'
    OR ${DEPOSIT_STALE_SQL} OR r.deposit_snapshot->>'source_hash' IS DISTINCT FROM ${DEPOSIT_SOURCE_HASH_SQL}))))`;
/**
 * A feed transaction that is a line of a CLOSED statement is `reconciled`: the book
 * already explains it, so it must never be confirmed again (the DB guard
 * `bank_statement_assert_open` would refuse anyway — this is what the screen shows
 * instead of "To review", 2026-09-14). Wins over the daily close and over any review.
 */
export const REVIEW_RECONCILED_SQL = `EXISTS(SELECT 1 FROM bank_statement_line sl
  JOIN bank_statement st ON st.id=sl.statement_id
  WHERE sl.transaction_id=t.id AND sl.deleted_at IS NULL AND st.status='closed' AND st.deleted_at IS NULL)`;
export const REVIEW_RECONCILED_JSON_SQL = `(SELECT jsonb_build_object('statement_id',st.id,'from_day',st.from_day,'to_day',st.to_day)
  FROM bank_statement_line sl JOIN bank_statement st ON st.id=sl.statement_id
  WHERE sl.transaction_id=t.id AND sl.deleted_at IS NULL AND st.status='closed' AND st.deleted_at IS NULL LIMIT 1)`;
export const REVIEW_STATUS_SQL = `CASE WHEN ${REVIEW_RECONCILED_SQL} THEN 'reconciled'
  WHEN dc.status='closed' THEN 'closed'
  WHEN ${REVIEW_STALE_SQL} THEN 'pending'
  WHEN r.status IN ('confirmed','excluded') THEN r.status ELSE 'pending' END`;
export const REVIEW_SELECT_SQL = `t.id,t.account_id,t.transaction_date AS date,t.name,t.merchant_name,
  (-t.amount::numeric)::text AS amount,t.currency,t.status,t.source_version,
  CASE WHEN r.id IS NULL THEN NULL ELSE ${REVIEW_JSON} END AS review,
  ${REVIEW_STATUS_SQL} AS review_status,${REVIEW_STALE_SQL} AS stale,
  COALESCE(dc.status='closed',false) AS day_closed,
  ${REVIEW_RECONCILED_JSON_SQL} AS reconciled,
  (SELECT COUNT(*)::integer FROM bank_review_attachment att WHERE att.transaction_id=t.id
    AND att.detached_at IS NULL AND att.deleted_at IS NULL) AS attachment_count`;

export function effectiveReviewStatus(
  tx: { source_version: number },
  review: Review | null,
  dayClosed: boolean,
  reconciled = false
): "reconciled" | "closed" | "pending" | "confirmed" | "excluded" {
  if (reconciled) return "reconciled";
  if (dayClosed) return "closed";
  if (
    !review ||
    review.source_version !== tx.source_version ||
    review.status === "draft"
  )
    return "pending";
  return review.status;
}
