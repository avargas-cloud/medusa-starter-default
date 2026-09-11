/**
 * The 9 keys of `gl_account_map` (plan `gl-core-v1` §3). This is the single
 * source of truth for the key list, its label and its allowed QB account
 * types — the account-map GET/POST routes and (via the JSON they return) the
 * POS screen all derive from this list, never a re-typed copy.
 */
export interface LedgerAccountMapKeyDef {
  key: string;
  label: string;
  allowedTypes: string[];
}

export const LEDGER_ACCOUNT_MAP_KEYS: LedgerAccountMapKeyDef[] = [
  {
    key: "accounts_receivable",
    label: "Accounts Receivable",
    allowedTypes: ["AccountsReceivable"],
  },
  {
    key: "undeposited_funds",
    label: "Undeposited Funds",
    allowedTypes: ["OtherCurrentAsset"],
  },
  {
    key: "sales_tax_payable",
    label: "Sales Tax Payable",
    allowedTypes: ["OtherCurrentLiability"],
  },
  {
    key: "inventory_asset",
    label: "Inventory Asset",
    allowedTypes: ["OtherCurrentAsset"],
  },
  {
    key: "sales_discounts",
    label: "Sales Discounts",
    allowedTypes: ["Income"],
  },
  {
    key: "shipping_income",
    label: "Shipping and Delivery Income",
    allowedTypes: ["Income"],
  },
  {
    key: "income_default",
    label: "Default Sales Income",
    allowedTypes: ["Income"],
  },
  {
    key: "cogs_default",
    label: "Default Cost of Goods Sold",
    allowedTypes: ["CostOfGoodsSold"],
  },
  {
    key: "bad_debt",
    label: "Bad Debt / Fraud Write-off",
    allowedTypes: ["Expense", "OtherExpense"],
  },
  {
    key: "accounts_payable",
    label: "Accounts Payable",
    allowedTypes: ["AccountsPayable"],
  },
  {
    key: "inventory_offset",
    label: "Inventory Offset Account",
    allowedTypes: ["OtherCurrentLiability"],
  },
];

export const LEDGER_ACCOUNT_MAP_KEY_SET = new Set(
  LEDGER_ACCOUNT_MAP_KEYS.map((entry) => entry.key)
);
