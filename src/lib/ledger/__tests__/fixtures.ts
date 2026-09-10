import { AccountMap, LedgerAccount } from "../types";

export function account(
  id: string,
  account_type: string,
  normal_balance: "debit" | "credit" | null = null
): LedgerAccount {
  return { id, name: id, account_type, currency: "USD", normal_balance };
}

/** Un mapa de cuentas completo y consistente para los builders puros. */
export function fakeAccountMap(): AccountMap {
  return {
    accounts_receivable: account("AR-1", "AccountsReceivable", "debit"),
    undeposited_funds: account("UF-1", "OtherCurrentAsset", "debit"),
    sales_tax_payable: account("TAX-1", "OtherCurrentLiability", "credit"),
    inventory_asset: account("INV-1", "OtherCurrentAsset", "debit"),
    sales_discounts: account("DISC-1", "Income", "credit"),
    shipping_income: account("SHIP-1", "Income", "credit"),
    income_default: account("INCOME-1", "Income", "credit"),
    cogs_default: account("COGS-1", "CostOfGoodsSold", "debit"),
    bad_debt: account("BADDEBT-1", "Expense", "debit"),
  };
}

export function sumDebits(lines: { debit_cents: bigint }[]): bigint {
  return lines.reduce((acc, l) => acc + l.debit_cents, 0n);
}
export function sumCredits(lines: { credit_cents: bigint }[]): bigint {
  return lines.reduce((acc, l) => acc + l.credit_cents, 0n);
}
