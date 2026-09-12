import {
  ACCOUNT_TYPE_ORDER,
  bsSectionFor,
  isProfitLossType,
  normalBalanceFor,
  normalizeSign,
  plSectionFor,
} from "../../lib/ledger/reports/sections";

describe("normalBalanceFor / normalizeSign", () => {
  it("assets, COGS and expenses are debit-normal; the rest credit-normal", () => {
    for (const t of ["Bank", "AccountsReceivable", "OtherCurrentAsset", "FixedAsset", "OtherAsset", "CostOfGoodsSold", "Expense", "OtherExpense"]) {
      expect(normalBalanceFor(t)).toBe("debit");
    }
    for (const t of ["AccountsPayable", "CreditCard", "OtherCurrentLiability", "LongTermLiability", "Equity", "Income", "OtherIncome"]) {
      expect(normalBalanceFor(t)).toBe("credit");
    }
  });

  it("income is positive when the raw (debit−credit) balance is negative", () => {
    expect(normalizeSign(-500n, "Income")).toBe(500n);
    expect(normalizeSign(-500n, "OtherIncome")).toBe(500n);
    expect(normalizeSign(300n, "Income")).toBe(-300n);
  });

  it("expenses / COGS keep the raw sign; liabilities flip it", () => {
    expect(normalizeSign(700n, "Expense")).toBe(700n);
    expect(normalizeSign(700n, "CostOfGoodsSold")).toBe(700n);
    expect(normalizeSign(-900n, "AccountsPayable")).toBe(900n);
    expect(normalizeSign(-900n, "Equity")).toBe(900n);
    expect(normalizeSign(400n, "Bank")).toBe(400n);
  });
});

describe("section mapping", () => {
  it("covers every posting type exactly once between P&L and balance sheet", () => {
    for (const t of ACCOUNT_TYPE_ORDER) {
      const pl = plSectionFor(t);
      const bs = bsSectionFor(t);
      expect(pl === null).not.toBe(bs === null);
      expect(isProfitLossType(t)).toBe(pl !== null);
    }
  });

  it("maps QB types to the report sections", () => {
    expect(plSectionFor("Income")).toBe("income");
    expect(plSectionFor("CostOfGoodsSold")).toBe("cogs");
    expect(plSectionFor("Expense")).toBe("expenses");
    expect(plSectionFor("OtherIncome")).toBe("other_income");
    expect(plSectionFor("OtherExpense")).toBe("other_expense");
    expect(bsSectionFor("Bank")).toBe("assets.current");
    expect(bsSectionFor("AccountsReceivable")).toBe("assets.current");
    expect(bsSectionFor("FixedAsset")).toBe("assets.fixed");
    expect(bsSectionFor("OtherAsset")).toBe("assets.other");
    expect(bsSectionFor("CreditCard")).toBe("liabilities.current");
    expect(bsSectionFor("LongTermLiability")).toBe("liabilities.long_term");
    expect(bsSectionFor("Equity")).toBe("equity");
    expect(bsSectionFor("NonPosting")).toBeNull();
    expect(plSectionFor("NonPosting")).toBeNull();
  });
});
