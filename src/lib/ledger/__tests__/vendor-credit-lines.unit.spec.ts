import { buildVendorCreditLines } from "../lines/vendor-credit";
import { account, fakePurchaseAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildVendorCreditLines", () => {
  const map = fakePurchaseAccountMap();
  const freightExpense = account("FREIGHT-EXP", "Expense", "debit");

  it("product-only credit: debits AP, credits inventory_asset", () => {
    const lines = buildVendorCreditLines(
      { totalCents: 500n, productAmountCents: 500n, accountLines: [] },
      map
    );
    expect(lines.find((l) => l.role === "accounts_payable")?.debit_cents).toBe(500n);
    expect(lines.find((l) => l.role === "inventory_asset")?.credit_cents).toBe(500n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("account-line credit: debits AP, credits the account (freight refund)", () => {
    const lines = buildVendorCreditLines(
      {
        totalCents: 200n,
        productAmountCents: 0n,
        accountLines: [{ account: freightExpense, amountCents: 200n }],
      },
      map
    );
    expect(lines.find((l) => l.role === "accounts_payable")?.debit_cents).toBe(200n);
    expect(lines.find((l) => l.role.startsWith("qb_account_"))?.credit_cents).toBe(200n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("mixed product + account credit balances", () => {
    const lines = buildVendorCreditLines(
      {
        totalCents: 700n,
        productAmountCents: 500n,
        accountLines: [{ account: freightExpense, amountCents: 200n }],
      },
      map
    );
    expect(sumDebits(lines)).toBe(700n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });
});
