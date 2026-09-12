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

  it("with a bank fee: Dr to (amount − fee) / Dr fee_account (fee) / Cr from (amount), balanced", () => {
    const fees = account("EXP-BANK-FEES", "Expense", "debit");
    const lines = buildBankTransferLines({
      fromAccount: checking,
      toAccount: savings,
      amount_cents: 50_000n,
      fee_cents: 350n,
      feeAccount: fees,
    });
    expect(lines).toEqual([
      { role: "to_account", account: savings, debit_cents: 49_650n, credit_cents: 0n },
      { role: "fee_account", account: fees, debit_cents: 350n, credit_cents: 0n },
      { role: "from_account", account: checking, debit_cents: 0n, credit_cents: 50_000n },
    ]);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("fee 0 (or omitted) emits no fee line even if a fee account is given", () => {
    const fees = account("EXP-BANK-FEES", "Expense", "debit");
    const lines = buildBankTransferLines({ fromAccount: checking, toAccount: savings, amount_cents: 100n, fee_cents: 0n, feeAccount: fees });
    expect(lines.map((l) => l.role)).toEqual(["to_account", "from_account"]);
    expect(lines[0]!.debit_cents).toBe(100n);
  });

  it("rejects a fee without account, a fee on a non-Expense account, a negative fee and a fee ≥ amount", () => {
    const reason = (r: string) => expect.objectContaining({ details: expect.objectContaining({ reason: r }) });
    const base = { fromAccount: checking, toAccount: savings, amount_cents: 1_000n };
    expect(() => buildBankTransferLines({ ...base, fee_cents: 10n })).toThrow(reason("fee_account_required"));
    expect(() => buildBankTransferLines({ ...base, fee_cents: 10n, feeAccount: card })).toThrow(
      reason("fee_account_type_not_expense")
    );
    expect(() => buildBankTransferLines({ ...base, fee_cents: -1n, feeAccount: account("EXP", "Expense") })).toThrow(
      reason("fee_negative")
    );
    expect(() => buildBankTransferLines({ ...base, fee_cents: 1_000n, feeAccount: account("EXP", "Expense") })).toThrow(
      reason("fee_not_below_amount")
    );
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
