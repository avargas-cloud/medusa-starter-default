import type { PoolClient } from "pg";

import { DEPOSIT_RECEIPT_SQL, type DepositCandidate } from "./deposit-read";
import {
  depositCents,
  depositMajor,
  depositSourceKey,
  type BankDeposit,
} from "./deposit-types";
import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  NO_DIRECT_RESERVATION_SQL,
  matchesPaymentFingerprint,
} from "./payment-evidence";
import { appendReviewEvent, reviewHash } from "./review-common";
import { validateCategory, type Category } from "./review-lookups";
import { BankingError } from "./security";

export async function validateDepositFee(
  client: PoolClient,
  amount: string,
  account: string | null | undefined,
  reference: string | null | undefined
): Promise<Category | null> {
  if (depositCents(amount) === 0n) return null;
  if (!account) throw new BankingError("BANKING_DEPOSIT_FEE_ACCOUNT_REQUIRED");
  if (!reference?.trim())
    throw new BankingError("BANKING_DEPOSIT_FEE_REFERENCE_REQUIRED");
  try {
    const category = await validateCategory(client, account);
    if (
      !["Expense", "OtherExpense", "CostOfGoodsSold"].includes(
        category.account_type
      )
    ) {
      throw new BankingError("BANKING_DEPOSIT_FEE_ACCOUNT_INVALID", 409);
    }
    return category;
  } catch {
    throw new BankingError("BANKING_DEPOSIT_FEE_ACCOUNT_INVALID", 409);
  }
}
export async function validateDepositReceipt(
  client: PoolClient,
  paymentId: string,
  depositId: string | null,
  currency: string,
  start: string,
  date: string,
  amount: string,
  expectedHash: string
): Promise<DepositCandidate> {
  const result = await client.query<DepositCandidate & { unreserved: boolean }>(
    `SELECT ${DEPOSIT_RECEIPT_SQL},
    ${NO_DIRECT_RESERVATION_SQL} AS unreserved FROM customer_payment mp
    JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE mp.id=$1 AND ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND upper(mp.currency)=$3
      AND (mp.received_at AT TIME ZONE 'America/New_York')::date BETWEEN $4::date AND $5::date FOR SHARE OF mp,c`,
    [paymentId, depositId, currency, start, date]
  );
  const payment = result.rows[0];
  if (!payment || !matchesPaymentFingerprint(expectedHash, payment))
    throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  if (
    !payment.unreserved ||
    depositCents(payment.available_amount) < depositCents(amount)
  ) {
    throw new BankingError("BANKING_DEPOSIT_OVER_RESERVED", 409);
  }
  return payment;
}
export async function validateDepositFunding(
  client: PoolClient,
  line: {
    payment_id?: string | null;
    manual?: boolean;
    reference?: string | null;
    description?: string | null;
    amount: string;
  },
  depositId: string | null,
  currency: string,
  start: string,
  date: string,
  expectedHash: string
): Promise<DepositCandidate> {
  depositSourceKey(line);
  if (!line.manual)
    return validateDepositReceipt(
      client,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositSourceKey() above throws unless exactly one of payment_id/manual is set; manual is falsy here
      line.payment_id!,
      depositId,
      currency,
      start,
      date,
      line.amount,
      expectedHash
    );
  // Manual Undeposited-Funds line: a pre-cutover receipt with no individual
  // customer_payment (the GL only recognizes payments received on/after the
  // cutover). Nothing to compare against a stored fingerprint — the hash is
  // derived from the line's own content, deterministic and tamper-evident.
  if (currency !== "USD")
    throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  const cents = depositCents(line.amount);
  if (cents <= 0n) throw new BankingError("BANKING_DEPOSIT_AMOUNT_INVALID");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositSourceKey() above throws unless line.reference is set when manual is true
  const reference = line.reference!;
  const description = line.description ?? "";
  const amount = depositMajor(cents);
  return {
    id: `manual:${reference}`,
    source_type: "manual",
    manual_reference: reference,
    manual_description: description || null,
    payment_id: null,
    display_id: null,
    customer_id: "",
    customer_name: description || reference,
    method: "manual_uf",
    date,
    reference,
    amount,
    available_amount: amount,
    currency: "USD",
    source_hash: reviewHash({ manual: true, reference, description, amount }),
  };
}
export async function guardDepositEdit(
  client: PoolClient,
  id: string
): Promise<void> {
  const posted = await client.query(
    `SELECT entry.id FROM bank_journal_entry entry
    WHERE entry.deposit_id=$1 AND entry.kind='deposit'
      AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=entry.id) LIMIT 1`,
    [id]
  );
  if (posted.rowCount)
    throw new BankingError("BANKING_DEPOSIT_ACCOUNTING_REVERSAL_REQUIRED", 409);
  const result = await client.query<{ closed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM bank_day_close dc
    WHERE dc.status='closed' AND dc.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(dc.snapshot->'accounts','[]'::jsonb)) a,
        jsonb_array_elements(COALESCE(a->'transactions','[]'::jsonb)) t WHERE t->'review'->>'matched_deposit_id'=$1)
      OR EXISTS(SELECT 1 FROM bank_transaction_review r JOIN bank_transaction t ON t.id=r.transaction_id
        WHERE r.matched_deposit_id=$1 AND r.deleted_at IS NULL AND t.transaction_date=dc.day))) AS closed`,
    [id]
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `SELECT EXISTS(...)` with no FROM clause always returns exactly one row
  if (result.rows[0]!.closed)
    throw new BankingError("BANKING_DEPOSIT_REOPEN_REQUIRED", 409);
}
export async function invalidateDepositReviews(
  client: PoolClient,
  deposit: BankDeposit,
  actorId: string,
  release: boolean
): Promise<void> {
  const result = await client.query<{
    id: string;
    transaction_id: string;
    revision: number;
  }>(
    `UPDATE bank_transaction_review
    SET status='draft',revision=revision+1,confirmed_by=NULL,confirmed_at=NULL,
      matched_deposit_id=CASE WHEN $2::boolean THEN NULL ELSE matched_deposit_id END,
      deposit_snapshot=CASE WHEN $2::boolean THEN NULL ELSE deposit_snapshot END,updated_at=now()
    WHERE matched_deposit_id=$1 AND deleted_at IS NULL RETURNING id,transaction_id,revision`,
    [deposit.id, release]
  );
  for (const review of result.rows)
    await appendReviewEvent(client, {
      entity_type: "review",
      entity_id: review.id,
      transaction_id: review.transaction_id,
      action: "deposit_changed",
      actor_id: actorId,
      details: {
        deposit_id: deposit.id,
        previous_deposit: deposit,
        revision: review.revision,
        released: release,
      },
    });
}
