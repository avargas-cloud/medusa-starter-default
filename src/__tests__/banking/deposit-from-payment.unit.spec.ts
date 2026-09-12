import {
  DEPOSIT_FROM_FEED_MEMO,
  DEPOSIT_SINGLE_RECEIPT_MEMO,
  depositFromPaymentBody,
  depositFromPaymentSchema,
} from "../../lib/banking/deposit-from-payment";
import { depositTotals } from "../../lib/banking/deposit-types";

const payment = { id: "cpay_1", display_id: 42, available_amount: "125.00", source_hash: "a".repeat(32), reference: "CHECK-9" };
const input = depositFromPaymentSchema.parse({ payment_id: "cpay_1", account_id: "acct_1", day: "2026-09-12", origin: "bank_feed" });

describe("one receipt → one-line ready deposit (bank feed / Record Deposits)", () => {
  it("builds a single-line deposit for the whole available amount, no fee, feed memo", () => {
    const body = depositFromPaymentBody(payment, input);
    expect(body.lines).toEqual([{ payment_id: "cpay_1", amount: "125.00", expected_source_hash: "a".repeat(32) }]);
    expect(body).toMatchObject({ expected_revision: 0, account_id: "acct_1", date: "2026-09-12", fee_amount: "0", memo: DEPOSIT_FROM_FEED_MEMO, reference: "CHECK-9" });
    expect(depositTotals(body.lines, body.fee_amount)).toEqual({ gross_amount: "125.00", fee_amount: "0.00", net_amount: "125.00" });
  });
  it("deposits the REMAINDER of a partially deposited receipt", () => {
    expect(depositFromPaymentBody({ ...payment, available_amount: "25.50" }, input).lines[0]?.amount).toBe("25.50");
  });
  it("prefers the caller's reference (bank feed description), then the receipt reference, then the receipt number", () => {
    expect(depositFromPaymentBody(payment, { ...input, reference: "  ACH CREDIT ACME  " }).reference).toBe("ACH CREDIT ACME");
    expect(depositFromPaymentBody({ ...payment, reference: null }, input).reference).toBe("Receipt 42");
    expect(depositFromPaymentBody({ ...payment, reference: null, display_id: null }, input).reference).toBe("Receipt cpay_1");
    expect(depositFromPaymentBody(payment, { ...input, reference: "x".repeat(300) }).reference).toHaveLength(200);
  });
  it("origin decides the memo; deposits_page is the default", () => {
    expect(depositFromPaymentSchema.parse({ payment_id: "p", account_id: "a", day: "2026-09-12" }).origin).toBe("deposits_page");
    expect(depositFromPaymentBody(payment, { ...input, origin: "deposits_page" }).memo).toBe(DEPOSIT_SINGLE_RECEIPT_MEMO);
  });
  test.each(["0", "0.00", "-1.00", "abc", "", "1.234"])("refuses a receipt with nothing left to deposit (%s) instead of writing a 0 line", available => {
    expect(() => depositFromPaymentBody({ ...payment, available_amount: available }, input)).toThrow();
  });
  it("rejects unknown fields and bad days at the boundary", () => {
    expect(depositFromPaymentSchema.safeParse({ ...input, transaction_id: "t" }).success).toBe(false);
    expect(depositFromPaymentSchema.safeParse({ ...input, day: "2026-02-30" }).success).toBe(false);
    expect(depositFromPaymentSchema.safeParse({ ...input, origin: "manual" }).success).toBe(false);
  });
});
