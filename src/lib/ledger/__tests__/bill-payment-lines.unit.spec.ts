import { buildBillPaymentLines } from "../lines/bill-payment";
import { account, fakePurchaseAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildBillPaymentLines", () => {
  const map = fakePurchaseAccountMap();
  const bank = account("BANK-1", "Bank", "debit");
  const card = account("CARD-1", "CreditCard", "credit");

  it("Bank payment: debits AP, credits the bank account", () => {
    const lines = buildBillPaymentLines({ amountCents: 1_000n, bankAccount: bank }, map);
    expect(lines.find((l) => l.role === "accounts_payable")?.debit_cents).toBe(1_000n);
    expect(lines.find((l) => l.role === "bank_account")?.credit_cents).toBe(1_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("CreditCard payment: same shape, different account", () => {
    const lines = buildBillPaymentLines({ amountCents: 250n, bankAccount: card }, map);
    expect(lines.find((l) => l.role === "bank_account")?.account.id).toBe("CARD-1");
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("$0 payment (credit-only SetCredit application): no lines to post", () => {
    const lines = buildBillPaymentLines({ amountCents: 0n, bankAccount: bank }, map);
    expect(lines).toHaveLength(0);
  });
});
