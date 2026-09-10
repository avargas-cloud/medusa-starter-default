import { buildCustomerPaymentLines } from "../lines/customer-payment";
import { LedgerError } from "../types";
import { fakeAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildCustomerPaymentLines", () => {
  const map = fakeAccountMap();

  it("posts a payment as debit undeposited_funds / credit accounts_receivable", () => {
    const lines = buildCustomerPaymentLines({ type: "payment", amountCents: 5000n }, map);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.role === "undeposited_funds")?.debit_cents).toBe(5000n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(5000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("posts a refund as the mirror image", () => {
    const lines = buildCustomerPaymentLines({ type: "refund", amountCents: 2500n }, map);
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(2500n);
    expect(lines.find((l) => l.role === "undeposited_funds")?.credit_cents).toBe(2500n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("rejects a non-positive amount", () => {
    expect(() => buildCustomerPaymentLines({ type: "payment", amountCents: 0n }, map)).toThrow(
      LedgerError
    );
  });
});
