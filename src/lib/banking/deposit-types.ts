import { z } from "zod";

import { reviewDate } from "./review-date";
import { BankingError } from "./security";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const depositMoney = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/);
/** A receipt line may be NEGATIVE: a card refund the processor nets in the batch (2026-09-15). */
export const depositSignedMoney = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/);
export const depositSaveSchema = z
  .object({
    id: id.optional(),
    expected_revision: z.number().int().min(0),
    account_id: id,
    date: reviewDate,
    // Optional since 2026-09-14: QuickBooks does not ask for a memo/ref on a
    // deposit either; the POS labels a blank one "Deposit <date>".
    reference: z.string().trim().max(200).default(""),
    memo: z.string().max(2000).default(""),
    fee_amount: depositMoney.default("0"),
    fee_account_list_id: id.nullable().optional(),
    fee_reference: z.string().trim().max(500).nullable().optional(),
    lines: z
      .array(
        z.union([
          z
            .object({
              payment_id: id,
              amount: depositSignedMoney,
              expected_source_hash: z.string().regex(/^[a-f0-9]{32}$/),
            })
            .strict(),
          z
            .object({
              payment_id: z.null(),
              manual: z.literal(true),
              reference: z.string().trim().min(1).max(500),
              description: z.string().trim().max(2000).default(""),
              amount: depositMoney,
            })
            .strict(),
        ])
      )
      .min(1)
      .max(100),
  })
  .strict();
export type DepositSaveBody = z.infer<typeof depositSaveSchema>;
export const depositReadySchema = z
  .object({
    expected_revision: z.number().int().positive(),
    expected_source_hash: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export const depositVoidSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type DepositLine = {
  id: string;
  payment_id: string | null;
  opening_item_id?: string;
  manual?: boolean;
  source_type?: "opening_item" | "manual";
  reference?: string;
  description?: string;
  /** Manual line only: the QuickBooks account the money comes FROM (null = Undeposited Funds). */
  account_list_id?: string | null;
  account_name?: string | null;
  payment_display_id: number | null;
  /** Receipt date (YYYY-MM-DD, ET) from the payment snapshot; null on manual lines and on lines saved before the snapshot carried it. */
  date?: string | null;
  customer_id: string;
  customer_name: string;
  method: string;
  payment_amount: string;
  /** Customer-paid card surcharge inside `amount`; "0.00" for cash/check and pre-2026-09-14 snapshots. */
  surcharge_amount: string;
  /** Card network (e.g. "visa"); null for cash/check and for snapshots recorded before 2026-09-14. */
  card_brand: string | null;
  amount: string;
  source_hash: string;
};
export type BankDeposit = {
  id: string;
  /** `DEP-####`, allocated when the deposit is recorded (2026-09-15). Null only for rows older than that. */
  number: string | null;
  revision: number;
  status: "draft" | "ready" | "void";
  /** Plaid account; null for deposits into a QuickBooks account with no feed (Cash Register, Cash on Hand). */
  account_id: string | null;
  /** QuickBooks ListID of the deposit-to account (`DepositToAccountRef`). */
  account_list_id: string | null;
  account_name: string;
  /** Set once QuickBooks holds the Deposit (DepositAdd confirmed, or adopted from QB). */
  qb_txn_id: string | null;
  qb_synced_at: string | null;
  currency: string;
  date: string;
  reference: string;
  memo: string;
  gross_amount: string;
  fee_amount: string;
  fee_account_list_id: string | null;
  fee_reference: string | null;
  fee_account_snapshot: {
    id: string;
    name: string;
    account_type: string;
  } | null;
  net_amount: string;
  source_hash: string;
  stale: boolean;
  accounting_posted: boolean;
  /** `bank_feed` when the matcher built it from one receipt; null when recorded by hand. */
  origin?: "bank_feed" | "deposits_page" | null;
  lines: DepositLine[];
};

export function depositCents(amount: string): bigint {
  if (!depositMoney.safeParse(amount).success)
    throw new BankingError("BANKING_DEPOSIT_AMOUNT_INVALID");
  const [whole, fraction = ""] = amount.split(".");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- split(".") siempre devuelve al menos un elemento, `whole` nunca es undefined
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export const depositMajor = (cents: bigint): string => {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};
/** Like `depositCents` but accepts a leading minus: an adopted QuickBooks
 * deposit can carry a negative line (card refund netted in the day's batch).
 * The UI never writes one (`depositMoney` stays unsigned). */
export function depositSignedCents(amount: string): bigint {
  const negative = amount.startsWith("-");
  const cents = depositCents(negative ? amount.slice(1) : amount);
  return negative ? -cents : cents;
}
export function depositSourceKey(line: {
  payment_id?: string | null;
  manual?: boolean;
  reference?: string | null;
}): string {
  if (Boolean(line.payment_id) === Boolean(line.manual))
    throw new BankingError("BANKING_DEPOSIT_LINES_INVALID");
  return line.manual ? `manual:${line.reference}` : `payment:${line.payment_id}`;
}
export function depositTotals(
  lines: Array<{
    payment_id?: string | null;
    manual?: boolean;
    reference?: string | null;
    amount: string;
  }>,
  fee: string
): { gross_amount: string; fee_amount: string; net_amount: string } {
  if (
    !lines.length ||
    lines.length > 100 ||
    new Set(lines.map(depositSourceKey)).size !== lines.length
  ) {
    throw new BankingError("BANKING_DEPOSIT_LINES_INVALID");
  }
  let gross = 0n;
  for (const line of lines) {
    const amount = depositSignedCents(line.amount);
    if (amount === 0n) throw new BankingError("BANKING_DEPOSIT_AMOUNT_INVALID");
    // A negative receipt line is a processor-batch refund (validated against the
    // refunded payment in validateDepositReceipt); a negative manual line only
    // exists on an adopted QuickBooks deposit.
    gross += amount;
  }
  const feeCents = depositCents(fee);
  // v4: gross 0 (dos líneas que se anulan, como un Make Deposits de $0) es válido; una comisión exige neto > 0.
  if (gross < 0n || (feeCents > 0n && gross <= feeCents)) throw new BankingError("BANKING_DEPOSIT_NET_INVALID");
  return {
    gross_amount: depositMajor(gross),
    fee_amount: depositMajor(feeCents),
    net_amount: depositMajor(gross - feeCents),
  };
}
