/** QB's standard chart-of-accounts group order (Bank first, OtherExpense last). */
export const ACCOUNT_TYPE_ORDER = [
  "Bank",
  "AccountsReceivable",
  "OtherCurrentAsset",
  "FixedAsset",
  "OtherAsset",
  "AccountsPayable",
  "CreditCard",
  "OtherCurrentLiability",
  "LongTermLiability",
  "Equity",
  "Income",
  "CostOfGoodsSold",
  "Expense",
  "OtherIncome",
  "OtherExpense",
] as const;

export type AccountType = (typeof ACCOUNT_TYPE_ORDER)[number];

export const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set(
  ACCOUNT_TYPE_ORDER
);

const DEBIT_NORMAL: ReadonlySet<string> = new Set([
  "Bank",
  "AccountsReceivable",
  "OtherCurrentAsset",
  "FixedAsset",
  "OtherAsset",
  "CostOfGoodsSold",
  "Expense",
  "OtherExpense",
]);

/** Normal side derived from the type — the only rule POST /accounts applies. */
export function normalBalanceFor(accountType: string): "debit" | "credit" {
  return DEBIT_NORMAL.has(accountType) ? "debit" : "credit";
}

/**
 * Raw journal balance is `Σdebit − Σcredit`. Reports show it signed by the
 * account's normal side: positive = the balance sits where the type expects
 * (a bank with money, an income account that earned, a liability owed).
 */
export function normalizeSign(rawCents: bigint, accountType: string): bigint {
  return normalBalanceFor(accountType) === "debit" ? rawCents : -rawCents;
}

export type PlSection =
  | "income"
  | "cogs"
  | "expenses"
  | "other_income"
  | "other_expense";

const PL_SECTION_BY_TYPE: Readonly<Record<string, PlSection>> = {
  Income: "income",
  CostOfGoodsSold: "cogs",
  Expense: "expenses",
  OtherIncome: "other_income",
  OtherExpense: "other_expense",
};

export function plSectionFor(accountType: string): PlSection | null {
  return PL_SECTION_BY_TYPE[accountType] ?? null;
}

export function isProfitLossType(accountType: string): boolean {
  return accountType in PL_SECTION_BY_TYPE;
}

export type BsSection =
  | "assets.current"
  | "assets.fixed"
  | "assets.other"
  | "liabilities.current"
  | "liabilities.long_term"
  | "equity";

const BS_SECTION_BY_TYPE: Readonly<Record<string, BsSection>> = {
  Bank: "assets.current",
  AccountsReceivable: "assets.current",
  OtherCurrentAsset: "assets.current",
  FixedAsset: "assets.fixed",
  OtherAsset: "assets.other",
  AccountsPayable: "liabilities.current",
  CreditCard: "liabilities.current",
  OtherCurrentLiability: "liabilities.current",
  LongTermLiability: "liabilities.long_term",
  Equity: "equity",
};

export function bsSectionFor(accountType: string): BsSection | null {
  return BS_SECTION_BY_TYPE[accountType] ?? null;
}
