import { z } from "zod";

import { reviewDate } from "./review-date";
import { BankingError } from "./security";

export type AccountingAccount = {
  id: string;
  name: string;
  account_type: string;
  currency: string | null;
  qb_currency_ref?: string | null;
};

/** qb_account stores CurrencyRef.FullName, not ISO. Income/expense accounts have no
 * independent currency in QB Desktop. Null expense currency inherits this ledger's
 * explicit USD functional currency; it does not verify QB home-currency settings.
 * Bank null stays unknown. This local normalization never writes the catalog or QB. */
export function bankAccountingCurrency(
  accountType: string,
  currencyRef: string | null
): "USD" | null {
  if (currencyRef === "USD" || currencyRef === "US Dollar") return "USD";
  if (currencyRef === null && ["Expense", "OtherExpense"].includes(accountType))
    return "USD";
  return null;
}
export type AccountingSource = {
  id: string;
  account_id: string;
  account_name: string;
  day: string;
  name: string;
  amount_cents: number | null;
  currency: string | null;
  category: AccountingAccount | null;
  bank_account: AccountingAccount | null;
  review_status: string;
  source_version: number;
  review_revision: number;
};
export type DuplicateCandidate = {
  key: string;
  kind: "vendor_bill" | "payroll" | "wire";
  id: string;
  reference: string;
  amount_cents: number;
  day: string;
  link_path: string;
  definite: boolean;
  fingerprint: string;
};
export const accountingDraftSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    nature: z.literal("new_direct_expense"),
    reference: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    attested: z.literal(true),
    dismissals: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            reason: z.string().trim().min(8).max(1000),
          })
          .strict()
      )
      .max(200),
  })
  .strict();
export const accountingPreviewSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict();
export const accountingPostSchema = accountingPreviewSchema
  .extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const accountingReverseSchema = z
  .object({
    posting_id: z.string().min(1).max(100),
    day: reviewDate,
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();
export type DraftInput = z.infer<typeof accountingDraftSchema>;
export type ExpenseDraft = Omit<DraftInput, "expected_revision"> & {
  id: string;
  revision: number;
  transaction_id: string;
};
export type JournalLine = {
  role: "expense" | "bank";
  account_list_id: string;
  account_name: string;
  account_type: string;
  debit_cents: number;
  credit_cents: number;
  account_snapshot: AccountingAccount;
};
export type JournalEntry = {
  id: string;
  day: string;
  kind: "expense" | "reversal";
  reference: string;
  description: string;
  amount_cents: number;
  source_hash: string;
  reverses_entry_id: string | null;
  reversed_by: string | null;
  reason: string | null;
  created_at: Date;
  lines: JournalLine[];
  stale: boolean;
};

/** Provider decimals are exact major units. Never round a bank debit into a different amount. */
export function bankExpenseCents(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value))
    throw new BankingError("BANKING_EXPENSE_AMOUNT_INVALID", 409);
  const [whole, fraction = ""] = value.split(".");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the regex above already matched, so split(".") always has a first element
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents < 1n || cents > 999999999999n)
    throw new BankingError("BANKING_EXPENSE_AMOUNT_INVALID", 409);
  return Number(cents);
}

export function expenseLines(source: AccountingSource): JournalLine[] {
  if (
    source.amount_cents === null ||
    !Number.isSafeInteger(source.amount_cents) ||
    source.amount_cents <= 0
  ) {
    throw new BankingError("BANKING_EXPENSE_AMOUNT_INVALID", 409);
  }
  if (!source.category || !source.bank_account)
    throw new BankingError("BANKING_EXPENSE_ACCOUNT_REQUIRED", 409);
  return [
    {
      role: "expense",
      account: source.category,
      debit: source.amount_cents,
      credit: 0,
    },
    {
      role: "bank",
      account: source.bank_account,
      debit: 0,
      credit: source.amount_cents,
    },
  ].map((row) => ({
    role: row.role as JournalLine["role"],
    account_list_id: row.account.id,
    account_name: row.account.name,
    account_type: row.account.account_type,
    account_snapshot: row.account,
    debit_cents: row.debit,
    credit_cents: row.credit,
  }));
}
