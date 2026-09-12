import { computeYearClose } from "../../lib/ledger/lines/year-close";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("computeYearClose", () => {
  const re = account("RE-1", "Equity", "credit");
  const sales = account("INC-SALES", "Income", "credit");
  const other = account("INC-OTHER", "OtherIncome", "credit");
  const cogs = account("COGS-1", "CostOfGoodsSold", "debit");
  const rent = account("EXP-RENT", "Expense", "debit");
  const zeroed = account("EXP-ZERO", "Expense", "debit");

  // Fixture of year balances (Σdr − Σcr): income credit → negative, expense debit → positive.
  const fixture = [
    { account: sales, balance_cents: -100_000n },
    { account: other, balance_cents: -5_000n },
    { account: cogs, balance_cents: 60_000n },
    { account: rent, balance_cents: 20_000n },
    { account: zeroed, balance_cents: 0n },
  ];

  it("profit: closes every account to zero and credits Retained Earnings by net income", () => {
    const { lines, per_account, net_income_cents } = computeYearClose(fixture, re);
    expect(net_income_cents).toBe(25_000n); // 105,000 income − 80,000 expense
    expect(per_account.map((p) => p.account.id)).toEqual(["INC-SALES", "INC-OTHER", "COGS-1", "EXP-RENT"]);
    expect(lines.find((l) => l.account.id === "INC-SALES")).toMatchObject({ debit_cents: 100_000n, credit_cents: 0n });
    expect(lines.find((l) => l.account.id === "COGS-1")).toMatchObject({ debit_cents: 0n, credit_cents: 60_000n });
    expect(lines.find((l) => l.role === "retained_earnings")).toMatchObject({ account: re, credit_cents: 25_000n });
    expect(lines.some((l) => l.account.id === "EXP-ZERO")).toBe(false);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(new Set(lines.map((l) => l.role)).size).toBe(lines.length);
  });

  it("loss: debits Retained Earnings", () => {
    const { lines, net_income_cents } = computeYearClose(
      [{ account: sales, balance_cents: -1_000n }, { account: rent, balance_cents: 4_000n }],
      re
    );
    expect(net_income_cents).toBe(-3_000n);
    expect(lines.find((l) => l.role === "retained_earnings")).toMatchObject({ debit_cents: 3_000n, credit_cents: 0n });
  });

  it("break-even: no Retained Earnings line, still balanced", () => {
    const { lines, net_income_cents } = computeYearClose(
      [{ account: sales, balance_cents: -7n }, { account: rent, balance_cents: 7n }],
      re
    );
    expect(net_income_cents).toBe(0n);
    expect(lines.some((l) => l.role === "retained_earnings")).toBe(false);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("nothing to close / non-P&L account / non-Equity RE → GL_SOURCE_INVALID", () => {
    expect(() => computeYearClose([{ account: zeroed, balance_cents: 0n }], re)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "nothing_to_close" }) })
    );
    expect(() => computeYearClose([{ account: account("BANK", "Bank"), balance_cents: 5n }], re)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "account_type_not_closable" }) })
    );
    expect(() => computeYearClose(fixture, account("X", "Bank"))).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "retained_earnings_not_equity" }) })
    );
  });
});
