import type { PoolClient } from "pg";
import { BankingError } from "./security";
import { openingContext, openingMapping } from "./opening-read";
import { openingPaymentSnapshot } from "./opening-funding";
import { acquireBankAccountingPeriodLock, assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { requireOpenReviewDay, reviewHash } from "./review-common";
import type { OpeningContext, OpeningPreview } from "./opening-types";

export async function openingPeriod(client: PoolClient, day: string): Promise<void> {
  await acquireBankAccountingPeriodLock(client, day);
  await assertBankAccountingPeriodOpen(client, day);
  await requireOpenReviewDay(client, day);
}
export async function validateOpening(client: PoolClient, id: string, revision: number): Promise<OpeningContext> {
  const context = await openingContext(client, id), b = context.opening;
  if (b.revision !== revision) throw new BankingError("BANKING_OPENING_STALE", 409);
  if (b.status !== "draft") throw new BankingError("BANKING_OPENING_DRAFT_REQUIRED", 409);
  await openingPeriod(client, b.cut_date);
  const live = await openingMapping(client, b.kind, b.bank_account_id);
  if (live.setup.cut_date !== b.cut_date || live.account.id !== b.account_list_id
    || live.account.account_type !== b.account_snapshot.account_type || live.account.currency !== "USD") {
    context.blockers.push("BANKING_OPENING_MAPPING_STALE");
  }
  const duplicate = await client.query(`SELECT id FROM bank_opening_balance WHERE status='adopted'
    AND kind=$1 AND account_list_id=$2 AND cut_date=$3 AND id<>$4 LIMIT 1`, [b.kind, b.account_list_id, b.cut_date, id]);
  if (duplicate.rowCount) context.blockers.push("BANKING_OPENING_ALREADY_ADOPTED");
  for (const item of context.items) {
    if (item.payment_id) {
      const payment = await openingPaymentSnapshot(client, item.payment_id, b.cut_date);
      context.blockers.push(...payment.blockers);
      if (payment.snapshot.payment_fingerprint !== item.source_snapshot.payment_fingerprint)
        context.blockers.push("BANKING_OPENING_SOURCE_DRIFT");
      if (payment.amount_cents === null || item.amount_cents > payment.amount_cents)
        context.blockers.push("BANKING_OPENING_AMOUNT_INVALID");
    }
    const claims = await client.query(`SELECT 1 FROM bank_opening_item other JOIN bank_opening_balance parent ON parent.id=other.opening_id
      WHERE parent.status='adopted' AND other.opening_id<>$1 AND
        (lower(trim(other.external_key))=lower(trim($2::text)) OR ($3::text IS NOT NULL AND other.payment_id=$3))
      UNION ALL SELECT 1 FROM bank_receipt_accounting WHERE payment_id=$3::text
      UNION ALL SELECT 1 FROM bank_deposit_line line JOIN bank_deposit deposit ON deposit.id=line.deposit_id
        WHERE line.payment_id=$3::text AND line.deleted_at IS NULL AND deposit.status IN ('draft','ready') AND deposit.deleted_at IS NULL
      UNION ALL SELECT 1 FROM bank_transaction_review WHERE matched_payment_id=$3::text AND status<>'excluded' AND deleted_at IS NULL LIMIT 1`,
    [id, item.external_key, item.payment_id]);
    if (claims.rowCount) context.blockers.push("BANKING_OPENING_SOURCE_ALREADY_CLAIMED");
  }
  const overlap = await client.query(`SELECT 1 FROM bank_journal_line line JOIN bank_journal_entry entry ON entry.id=line.entry_id
    WHERE line.account_list_id=$1 AND entry.day<$2 AND entry.kind<>'reversal' LIMIT 1`, [b.account_list_id, b.cut_date]);
  if (overlap.rowCount) context.blockers.push("BANKING_OPENING_PRECUT_JOURNAL_OVERLAP");
  context.blockers = [...new Set(context.blockers)];
  if (context.blockers.length) throw new BankingError(context.blockers[0]!, 409);
  return context;
}
export function openingPreview(context: OpeningContext): OpeningPreview {
  const b = context.opening;
  return { opening_id: b.id, revision: b.revision, source_hash: context.source_hash,
    preview_hash: reviewHash({ source_hash: context.source_hash, revision: b.revision, evidence_attested: true }),
    difference_cents: context.difference_cents!, book_balance_cents: b.book_balance_cents!,
    statement_balance_cents: b.statement_balance_cents, item_count: context.items.length,
    blockers: [], zero_gl: true, coverage: "partial" };
}
