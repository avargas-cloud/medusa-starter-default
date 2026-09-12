import { buildBankTransferLines } from "../../lib/ledger/lines/bank-transfer";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("buildBankTransferLines", () => {
  const checking = account("BANK-CHK", "Bank", "debit");
  const savings = account("BANK-SAV", "Bank", "debit");
  const card = account("CARD-1", "CreditCard", "credit");

  it("Dr to_account / Cr from_account", () => {
    const lines = buildBankTransferLines({ fromAccount: checking, toAccount: savings, amount_cents: 50_000n });
    expect(lines).toEqual([
      { role: "to_account", account: savings, debit_cents: 50_000n, credit_cents: 0n },
      { role: "from_account", account: checking, debit_cents: 0n, credit_cents: 50_000n },
    ]);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("paying a credit card from checking debits the card", () => {
    const lines = buildBankTransferLines({ fromAccount: checking, toAccount: card, amount_cents: 1n });
    expect(lines[0]).toMatchObject({ account: card, debit_cents: 1n });
  });

  it("rejects non-positive amount, same account, and P&L accounts", () => {
    expect(() => buildBankTransferLines({ fromAccount: checking, toAccount: savings, amount_cents: 0n })).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "amount_not_positive" }) })
    );
    expect(() => buildBankTransferLines({ fromAccount: checking, toAccount: checking, amount_cents: 1n })).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "same_account" }) })
    );
    expect(() =>
      buildBankTransferLines({ fromAccount: checking, toAccount: account("EXP", "Expense"), amount_cents: 1n })
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: "account_type_not_transferable" }) }));
  });
});
