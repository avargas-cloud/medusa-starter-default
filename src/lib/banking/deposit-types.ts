import { z } from "zod";

import { reviewDate } from "./review-date";
import { BankingError } from "./security";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const depositMoney = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/);
export const depositSaveSchema = z
  .object({
    id: id.optional(),
    expected_revision: z.number().int().min(0),
    account_id: id,
    date: reviewDate,
    reference: z.string().trim().min(1).max(200),
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
              amount: depositMoney,
              expected_source_hash: z.string().regex(/^[a-f0-9]{32}$/),
            })
            .strict(),
          z
            .object({
              opening_item_id: id,
              amount: depositMoney,
              expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
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
  source_type?: "opening_item";
  reference?: string;
  payment_display_id: number | null;
  customer_id: string;
  customer_name: string;
  method: string;
  payment_amount: string;
  amount: string;
  source_hash: string;
};
export type BankDeposit = {
  id: string;
  revision: number;
  status: "draft" | "ready" | "void";
  account_id: string;
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
  lines: DepositLine[];
};

export function depositCents(amount: string): bigint {
  if (!depositMoney.safeParse(amount).success)
    throw new BankingError("BANKING_DEPOSIT_AMOUNT_INVALID");
  const [whole, fraction = ""] = amount.split(".");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- split(".") siempre devuelve al menos un elemento, `whole` nunca es undefined
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export const depositMajor = (cents: bigint): string =>
  `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
export function depositSourceKey(line: {
  payment_id?: string | null;
  opening_item_id?: string | null;
}): string {
  if (Boolean(line.payment_id) === Boolean(line.opening_item_id))
    throw new BankingError("BANKING_DEPOSIT_LINES_INVALID");
  return line.opening_item_id
    ? `opening_item:${line.opening_item_id}`
    : `payment:${line.payment_id}`;
}
export function depositTotals(
  lines: Array<{
    payment_id?: string | null;
    opening_item_id?: string | null;
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
    const amount = depositCents(line.amount);
    if (amount <= 0n) throw new BankingError("BANKING_DEPOSIT_AMOUNT_INVALID");
    gross += amount;
  }
  const feeCents = depositCents(fee);
  if (gross <= feeCents) throw new BankingError("BANKING_DEPOSIT_NET_INVALID");
  return {
    gross_amount: depositMajor(gross),
    fee_amount: depositMajor(feeCents),
    net_amount: depositMajor(gross - feeCents),
  };
}
