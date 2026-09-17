import { buildSalesTaxAdjustmentLines, buildSalesTaxPaymentLines, salesTaxPaymentTotal } from "../lines/sales-tax";
import { LedgerError, type LedgerAccount } from "../types";

const acct = (id: string, account_type: string): LedgerAccount => ({ id, name: id, account_type, currency: "USD", normal_balance: null });
const payable = acct("80000035-1317847950", "OtherCurrentLiability");
const bank = acct("8000017B-1738860533", "Bank");
const income = acct("80000090-1381441032", "OtherIncome");
const expense = acct("800000CA-1402928386", "Expense");

describe("sales tax ledger lines", () => {
  it("allowance (decrease): Dr payable / Cr income", () => {
    const lines = buildSalesTaxAdjustmentLines({ payable, offset: income, direction: "decrease", amount_cents: 3000n });
    expect(lines.map((l) => [l.role, l.account.id, l.debit_cents, l.credit_cents])).toEqual([
      ["sales_tax_payable", payable.id, 3000n, 0n],
      ["offset", income.id, 0n, 3000n],
    ]);
  });

  it("penalty (increase): Dr expense / Cr payable", () => {
    const lines = buildSalesTaxAdjustmentLines({ payable, offset: expense, direction: "increase", amount_cents: 5000n });
    expect(lines.map((l) => [l.role, l.debit_cents, l.credit_cents])).toEqual([
      ["offset", 5000n, 0n],
      ["sales_tax_payable", 0n, 5000n],
    ]);
  });

  it("rejects a non-liability payable, a zero amount and an offset equal to the payable", () => {
    expect(() => buildSalesTaxAdjustmentLines({ payable: bank, offset: income, direction: "decrease", amount_cents: 1n })).toThrow(LedgerError);
    expect(() => buildSalesTaxAdjustmentLines({ payable, offset: income, direction: "decrease", amount_cents: 0n })).toThrow(LedgerError);
    expect(() => buildSalesTaxAdjustmentLines({ payable, offset: payable, direction: "decrease", amount_cents: 1n })).toThrow(LedgerError);
  });

  it("payment: Dr payable / Cr bank by the NET (gross 6,292.38 − 30 allowance = 6,262.38)", () => {
    const input = { payable, bankAccount: bank, tax_cents: 629238n, adjustment_cents: [-3000n] };
    expect(salesTaxPaymentTotal(input)).toBe(626238n);
    const lines = buildSalesTaxPaymentLines(input);
    expect(lines.map((l) => [l.role, l.debit_cents, l.credit_cents])).toEqual([
      ["sales_tax_payable", 626238n, 0n],
      ["bank_account", 0n, 626238n],
    ]);
  });

  it("payment rejects: non-positive tax, zero adjustment line, credit-card 'bank', net ≤ 0", () => {
    expect(() => buildSalesTaxPaymentLines({ payable, bankAccount: bank, tax_cents: 0n, adjustment_cents: [] })).toThrow(LedgerError);
    expect(() => buildSalesTaxPaymentLines({ payable, bankAccount: bank, tax_cents: 100n, adjustment_cents: [0n] })).toThrow(LedgerError);
    expect(() => buildSalesTaxPaymentLines({ payable, bankAccount: acct("cc", "CreditCard"), tax_cents: 100n, adjustment_cents: [] })).toThrow(LedgerError);
    expect(() => buildSalesTaxPaymentLines({ payable, bankAccount: bank, tax_cents: 100n, adjustment_cents: [-100n] })).toThrow(LedgerError);
  });
});
