import { z } from "zod";

import { getDbPool } from "../../api/utils/db-pool";

import { readyBankDeposit, saveBankDeposit } from "./deposit-core";
import {
  DEPOSIT_RECEIPT_SQL,
  depositAccount,
  type DepositCandidate,
} from "./deposit-read";
import {
  depositMoney,
  depositSaveSchema,
  type BankDeposit,
  type DepositSaveBody,
} from "./deposit-types";
import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  NO_DIRECT_RESERVATION_SQL,
} from "./payment-evidence";
import { reviewDate } from "./review-date";
import { BankingError, requireBankingEnabled } from "./security";

/**
 * "Deposit one receipt" (2026-09-12): a single customer payment becomes a
 * ONE-LINE ready deposit so there is a single way to move Undeposited Funds
 * to a bank account. Callers: the bank-feed matcher (origin `bank_feed`,
 * replaces the legacy `mode:'match'` / `matched_payment_id`) and the quick
 * action on Record Deposits (origin `deposits_page`).
 *
 * Reuses `saveBankDeposit` + `readyBankDeposit` unchanged — no new tables.
 * Each step keeps its own idempotency key derived from the caller's, so a
 * retry after "saved but not ready" replays the save (cached) and re-tries
 * the ready. Worst case on a failed ready: a visible DRAFT deposit, never a
 * half-written one.
 */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const depositFromPaymentSchema = z
  .object({
    payment_id: id,
    account_id: id,
    day: reviewDate,
    reference: z.string().trim().max(200).optional(),
    origin: z.enum(["bank_feed", "deposits_page"]).default("deposits_page"),
  })
  .strict();
export type DepositFromPaymentBody = z.infer<typeof depositFromPaymentSchema>;
export type DepositOrigin = DepositFromPaymentBody["origin"];
export const DEPOSIT_FROM_FEED_MEMO = "Matched from bank feed";
export const DEPOSIT_SINGLE_RECEIPT_MEMO = "Single receipt";

/** Pure: the one-line deposit body for a receipt. Deposits the whole
 * AVAILABLE amount (a partially deposited receipt deposits its remainder). */
export function depositFromPaymentBody(
  payment: Pick<
    DepositCandidate,
    "id" | "display_id" | "available_amount" | "source_hash" | "reference"
  >,
  input: DepositFromPaymentBody
): DepositSaveBody {
  if (
    !depositMoney.safeParse(payment.available_amount).success ||
    Number(payment.available_amount) <= 0
  ) {
    throw new BankingError("BANKING_DEPOSIT_OVER_RESERVED", 409);
  }
  const reference =
    input.reference?.trim() ||
    payment.reference?.trim() ||
    `Receipt ${payment.display_id ?? payment.id}`;
  const parsed = depositSaveSchema.safeParse({
    expected_revision: 0,
    account_id: input.account_id,
    date: input.day,
    reference: reference.slice(0, 200),
    memo:
      input.origin === "bank_feed"
        ? DEPOSIT_FROM_FEED_MEMO
        : DEPOSIT_SINGLE_RECEIPT_MEMO,
    fee_amount: "0",
    lines: [
      {
        payment_id: payment.id,
        amount: payment.available_amount,
        expected_source_hash: payment.source_hash,
      },
    ],
  });
  if (!parsed.success) throw new BankingError("BANKING_INVALID_REQUEST");
  return parsed.data;
}

/** The receipt as the deposit editor would list it for this account
 * (same eligibility, currency and reservation rules as `depositCandidates`). */
async function loadDepositPayment(
  paymentId: string,
  accountId: string
): Promise<DepositCandidate> {
  const pool = getDbPool();
  const account = await depositAccount(pool, accountId);
  const result = await pool.query<DepositCandidate>(
    `SELECT ${DEPOSIT_RECEIPT_SQL} FROM customer_payment mp
    JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
    WHERE mp.id=$1 AND ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND ${NO_DIRECT_RESERVATION_SQL} AND upper(mp.currency)=$3`,
    [paymentId, null, account.currency]
  );
  if (!result.rows[0]) throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
  return result.rows[0];
}

export async function createReadyDepositFromPayment(
  actorId: string,
  key: string | undefined,
  input: DepositFromPaymentBody
): Promise<{ deposit: BankDeposit }> {
  requireBankingEnabled();
  const parsed = depositFromPaymentSchema.safeParse(input);
  if (!parsed.success) throw new BankingError("BANKING_INVALID_REQUEST");
  // Two derived keys must still fit the 128-char command key.
  if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))
    throw new BankingError("BANKING_IDEMPOTENCY_KEY_REQUIRED");
  const payment = await loadDepositPayment(
    parsed.data.payment_id,
    parsed.data.account_id
  );
  const saved = await saveBankDeposit(
    actorId,
    `${key}:save`,
    depositFromPaymentBody(payment, parsed.data),
    parsed.data.origin
  );
  return readyBankDeposit(saved.deposit.id, actorId, `${key}:ready`, {
    expected_revision: saved.deposit.revision,
    expected_source_hash: saved.deposit.source_hash,
  });
}
