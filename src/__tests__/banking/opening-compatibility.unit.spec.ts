import { receiptPaymentFacts, type PaymentRow } from "../../lib/banking/receipts-source";
import { reviewHash } from "../../lib/banking/review-common";

const row: PaymentRow = { id: "cpay_pre_cut", display_id: 7, customer_id: "customer", source: "pos", type: "payment",
  amount: "50000.00", currency: "usd", method: "check", status: "available", batch_day: "2000-01-01",
  reference: "CHECK-7", received_at: new Date("2000-01-01T17:00:00Z"), locked_order_id: null,
  deleted: false, customer_deleted: false, metadata: {}, qb: {}, medusa_payment_id: null, medusa_refund_id: null };

describe("v10 keeps the v9 monetary evidence envelope frozen", () => {
  it("keeps the exact v9 facts shape; opening status is a separate projection", () => {
    expect(receiptPaymentFacts(row)).toEqual({ fingerprint_version: 1, id: "cpay_pre_cut", customer_id: "customer",
      source: "pos", type: "payment", amount: "50000", currency: "USD", method: "check", status: "available",
      batch_day: "2000-01-01", received_at: new Date("2000-01-01T17:00:00Z"), reference: "CHECK-7",
      deleted: false, customer_deleted: false, medusa_refund_id: null,
      provenance: { qb_source: null, is_sales_receipt_payment: null, pending_sr: false, qb_import: null,
        qb_source_kind: null, refund_amount: null, terminal_refunded: null } });
  });
  it("opening presentation flags and AR allocation cannot change existing receipt hashes", () => {
    const presentation = { ...row, status: "applied", locked_order_id: "order", metadata: {
      opening_pending: false, opening_id: "baseline", order_id: "order", pos_notes: "display only",
    } };
    expect(reviewHash(receiptPaymentFacts(presentation))).toBe(reviewHash(receiptPaymentFacts(row)));
  });
  it.each<Partial<PaymentRow>>([
    { batch_day: "2000-01-02" }, { amount: "20000" }, { reference: "CHECK-OTHER" },
    { status: "refunded" }, { deleted: true }, { customer_deleted: true },
    { metadata: { refund_amount: 1 } }, { metadata: { terminal_refunded: true } },
    { medusa_refund_id: "refund" }, { qb: { source: "sales_receipt" } },
  ])("keeps monetary drift visible rather than normalizing it away: %j", change => {
    expect(reviewHash(receiptPaymentFacts({ ...row, ...change }))).not.toBe(reviewHash(receiptPaymentFacts(row)));
  });
});
