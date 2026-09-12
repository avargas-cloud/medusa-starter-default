import { bankCheckTotal, buildBankCheckLines, deriveBankCheckKind } from "../../lib/ledger/lines/bank-check";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("deriveBankCheckKind", () => {
  it("CreditCard account → card_charge regardless of number", () => {
    expect(deriveBankCheckKind("CreditCard", "1001")).toBe("card_charge");
    expect(deriveBankCheckKind("CreditCard", null)).toBe("card_charge");
  });
  it("Bank account with a number → check; without → expense", () => {
    expect(deriveBankCheckKind("Bank", "1001")).toBe("check");
    expect(deriveBankCheckKind("Bank", "")).toBe("expense");
    expect(deriveBankCheckKind("Bank", "   ")).toBe("expense");
    expect(deriveBankCheckKind("Bank", undefined)).toBe("expense");
  });
});

describe("buildBankCheckLines", () => {
  const bank = account("BANK-1", "Bank", "debit");
  const card = account("CARD-1", "CreditCard", "credit");
  const office = account("EXP-OFFICE", "Expense", "debit");
  const fuel = account("EXP-FUEL", "Expense", "debit");

  it("Dr each line / Cr bank by the total", () => {
    const lines = buildBankCheckLines({
      bankAccount: bank,
      lines: [
        { account: office, amount_cents: 1_000n, memo: "paper" },
        { account: fuel, amount_cents: 234n },
      ],
    });
    expect(lines.map((l) => l.role)).toEqual(["item_1", "item_2", "bank_account"]);
    expect(lines[0]).toMatchObject({ account: office, debit_cents: 1_000n, credit_cents: 0n, memo: "paper" });
    expect(lines[2]).toMatchObject({ account: bank, debit_cents: 0n, credit_cents: 1_234n });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(bankCheckTotal([{ amount_cents: 1_000n }, { amount_cents: 234n }])).toBe(1_234n);
  });

  it("card charge: same shape, credits the CreditCard account", () => {
    const lines = buildBankCheckLines({ bankAccount: card, lines: [{ account: fuel, amount_cents: 500n }] });
    expect(lines.find((l) => l.role === "bank_account")).toMatchObject({ account: card, credit_cents: 500n });
  });

  it("negative line credits its account; total must stay positive", () => {
    const lines = buildBankCheckLines({
      bankAccount: bank,
      lines: [
        { account: office, amount_cents: 1_000n },
        { account: fuel, amount_cents: -300n },
      ],
    });
    expect(lines[1]).toMatchObject({ account: fuel, debit_cents: 0n, credit_cents: 300n });
    expect(lines[2]?.credit_cents).toBe(700n);
    expect(() =>
      buildBankCheckLines({ bankAccount: bank, lines: [{ account: office, amount_cents: -1n }] })
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: "total_not_positive" }) }));
  });

  it("zero line, no lines, non-bank counter account → GL_SOURCE_INVALID", () => {
    expect(() => buildBankCheckLines({ bankAccount: bank, lines: [{ account: office, amount_cents: 0n }] })).toThrow(
      expect.objectContaining({ code: "GL_SOURCE_INVALID" })
    );
    expect(() => buildBankCheckLines({ bankAccount: bank, lines: [] })).toThrow(
      expect.objectContaining({ code: "GL_SOURCE_INVALID" })
    );
    expect(() => buildBankCheckLines({ bankAccount: office, lines: [{ account: fuel, amount_cents: 1n }] })).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "bank_account_type" }) })
    );
  });
});
