import { buildBankDepositLines } from "../../lib/ledger/lines/bank-deposit";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("buildBankDepositLines (Make Deposits)", () => {
  const bank = account("BANK-1", "Bank", "debit");
  const cashOnHand = account("OCA-CASH", "OtherCurrentAsset", "debit");
  const uf = account("UF", "OtherCurrentAsset", "debit");
  const ap = account("AP", "AccountsPayable", "credit");
  const fees = account("EXP-FEES", "Expense", "debit");

  it("Dr bank by the gross / Cr each source line (UF for receipts)", () => {
    const lines = buildBankDepositLines({
      bankAccount: bank,
      lines: [
        { account: uf, amount_cents: 35_203n, memo: "Payment 3751 · Acme" },
        { account: uf, amount_cents: 4_000n, memo: "pre-cutover check" },
      ],
    });
    expect(lines.map((l) => l.role)).toEqual(["bank_account", "item_1", "item_2"]);
    expect(lines[0]).toMatchObject({ account: bank, debit_cents: 39_203n, credit_cents: 0n });
    expect(lines[1]).toMatchObject({ account: uf, debit_cents: 0n, credit_cents: 35_203n, memo: "Payment 3751 · Acme" });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("fee: Dr expense, bank receives the net", () => {
    const lines = buildBankDepositLines({
      bankAccount: bank,
      lines: [{ account: uf, amount_cents: 39_203n }],
      fee: { account: fees, amount_cents: 125n, memo: "Fee processor" },
    });
    expect(lines.map((l) => l.role)).toEqual(["bank_account", "fee", "item_1"]);
    expect(lines[0]).toMatchObject({ debit_cents: 39_078n });
    expect(lines[1]).toMatchObject({ account: fees, debit_cents: 125n, memo: "Fee processor" });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("manual line against another account (vendor refund → AP) credits that account", () => {
    const lines = buildBankDepositLines({ bankAccount: bank, lines: [{ account: ap, amount_cents: 1_000n, memo: "Legrand refund" }] });
    expect(lines[1]).toMatchObject({ account: ap, credit_cents: 1_000n });
  });

  it("a negative line (card refund netted in the batch) DEBITS its account; bank gets the net", () => {
    const lines = buildBankDepositLines({
      bankAccount: bank,
      lines: [
        { account: uf, amount_cents: 71_786n },
        { account: uf, amount_cents: -2_139n, memo: "QB ARRefundCreditCard" },
      ],
    });
    expect(lines[0]).toMatchObject({ debit_cents: 69_647n });
    expect(lines[2]).toMatchObject({ account: uf, debit_cents: 2_139n, credit_cents: 0n });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("deposits into an OtherCurrentAsset (Cash on Hand) are allowed; other types are not", () => {
    expect(() => buildBankDepositLines({ bankAccount: cashOnHand, lines: [{ account: uf, amount_cents: 100n }] })).not.toThrow();
    expect(() => buildBankDepositLines({ bankAccount: fees, lines: [{ account: uf, amount_cents: 100n }] })).toThrow("GL_SOURCE_INVALID");
  });

  it("rejects: no lines, zero line, gross ≤ 0, fee ≥ gross, fee < 0, NonPosting source", () => {
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [] })).toThrow("GL_SOURCE_INVALID");
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [{ account: uf, amount_cents: 0n }] })).toThrow("GL_SOURCE_INVALID");
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [{ account: uf, amount_cents: -5n }] })).toThrow("GL_SOURCE_INVALID");
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [{ account: uf, amount_cents: 100n }], fee: { account: fees, amount_cents: 100n } })).toThrow("GL_SOURCE_INVALID");
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [{ account: uf, amount_cents: 100n }], fee: { account: fees, amount_cents: -1n } })).toThrow("GL_SOURCE_INVALID");
    expect(() => buildBankDepositLines({ bankAccount: bank, lines: [{ account: account("NP", "NonPosting", null), amount_cents: 100n }] })).toThrow("GL_SOURCE_INVALID");
  });
});
