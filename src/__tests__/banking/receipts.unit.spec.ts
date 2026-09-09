import { receiptPaymentBlockers, receiptPaymentFacts, receiptLine, type PaymentRow } from "../../lib/banking/receipts-source";
import { receiptMapping } from "../../lib/banking/receipts-setup";
import { reviewHash } from "../../lib/banking/review-common";
import { receiptSetupSchema, type ReceiptSetup } from "../../lib/banking/receipts-types";

const ar = { id: "ar", name: "Accounts Receivable", account_type: "AccountsReceivable", currency: "USD" };
const clearing = { id: "uf", name: "Undeposited Funds", account_type: "OtherCurrentAsset", currency: "USD" };
const setup: ReceiptSetup = { id: "local-usd", revision: 1, cut_date: "2000-01-01", currency: "USD",
  ar_account: ar, clearing_account: clearing, attested: true, frozen: false };
const payment: PaymentRow = { id: "cpay", display_id: 1, customer_id: "customer", source: "pos", type: "payment",
  amount: "12001", currency: "usd", method: "check", status: "available", batch_day: "2000-01-15", reference: "CHECK-123",
  received_at: new Date("2000-01-15T20:00:00Z"), locked_order_id: null, deleted: false, customer_deleted: false,
  metadata: {}, qb: {}, medusa_payment_id: null, medusa_refund_id: null };

describe("local receipt accounting boundaries", () => {
  it("allows card recognition only under the merchant policy while retaining provenance controls", () => {
    for (const method of ["credit_card", "debit_card", "card"]) {
      const card = { ...payment, method };
      expect(receiptPaymentBlockers(card,setup)).toContain("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
      expect(receiptPaymentBlockers(card,setup,"card")).toEqual([]);
      for (const metadata of [{qb_import:true},{is_sales_receipt_payment:true},{refund_amount:1}]) {
        expect(receiptPaymentBlockers({...card,metadata},setup,"card")).toContain("BANKING_RECEIPT_PROVENANCE_UNSUPPORTED");
      }
    }
    expect(receiptPaymentBlockers(payment,setup,"card")).toContain("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
  });
  it("recognizes cents as full clearing debit and AR credit without sales or application income", () => {
    expect(receiptPaymentBlockers(payment, setup)).toEqual([]);
    const lines = [receiptLine("clearing", clearing, 12001, true), receiptLine("receivable", ar, 12001, false)];
    expect(lines.map(l => [l.role, l.debit_cents, l.credit_cents])).toEqual([["clearing",12001,0],["receivable",0,12001]]);
    expect(lines.reduce((sum, l) => sum + l.debit_cents - l.credit_cents, 0)).toBe(0);
  });
  it.each(["available", "partially_applied", "applied"])("normal AR state %s preserves recognition identity", status => {
    expect(reviewHash(receiptPaymentFacts({ ...payment, status }))).toBe(reviewHash(receiptPaymentFacts(payment)));
    expect(receiptPaymentBlockers({ ...payment, status }, setup)).toEqual([]);
  });
  it("order allocation and a Medusa mirror do not pretend to be a new cash receipt", () => {
    const allocated = { ...payment, locked_order_id: "order", medusa_payment_id: "mirror", metadata: { order_id: "order" } };
    expect(receiptPaymentBlockers(allocated, setup)).toEqual([]);
    expect(reviewHash(receiptPaymentFacts(allocated))).toBe(reviewHash(receiptPaymentFacts(payment)));
  });
  it.each(["voided", "refunded", "partial_refunded", "unknown"])("negative or unknown state %s stays unresolved", status => {
    expect(receiptPaymentBlockers({ ...payment, status }, setup)).toContain("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
    expect(reviewHash(receiptPaymentFacts({ ...payment, status }))).not.toBe(reviewHash(receiptPaymentFacts(payment)));
  });
  it.each(["0", "-1", "1.5", "1e3", "1000000000000", "NaN"])("invalid cent amount %s is never rounded", amount => {
    expect(receiptPaymentBlockers({ ...payment, amount }, setup)).toContain("BANKING_RECEIPT_AMOUNT_INVALID");
  });
  it("numeric database scale zero is the same economic integer", () => {
    expect(receiptPaymentBlockers({ ...payment, amount: "12001.000" }, setup)).toEqual([]);
    expect(receiptPaymentFacts({ ...payment, amount: "12001.000" })).toEqual(receiptPaymentFacts(payment));
  });
  it.each([{ qb_source: "sales_receipt" }, { is_sales_receipt_payment: true }, { qb_sync_status: "pending_sr" },
    { qb_import: true }, { qb_source: "unknown" }, { refund_amount: 10 }, { terminal_refunded: true }])("rejects unsupported identity %j", metadata => {
    expect(receiptPaymentBlockers({ ...payment, metadata }, setup)).toContain("BANKING_RECEIPT_PROVENANCE_UNSUPPORTED");
  });
  it("QB explicit SalesReceipt and missing/deleted sources cannot be reclassified", () => {
    expect(receiptPaymentBlockers({ ...payment, qb: { source: "sales_receipt" } }, setup)).toContain("BANKING_RECEIPT_PROVENANCE_UNSUPPORTED");
    expect(receiptPaymentBlockers({ ...payment, deleted: true }, setup)).toContain("BANKING_RECEIPT_SOURCE_UNSUPPORTED");
  });
  it("requires an evidenced merchant batch date on or after cut", () => {
    expect(receiptPaymentBlockers({ ...payment, batch_day: null }, setup)).toContain("BANKING_RECEIPT_DATE_INVALID");
    expect(receiptPaymentBlockers({ ...payment, batch_day: "2000-02-30" }, setup)).toContain("BANKING_RECEIPT_DATE_INVALID");
    expect(receiptPaymentBlockers({ ...payment, batch_day: "1999-12-31" }, setup)).toContain("BANKING_RECEIPT_BEFORE_CUT");
    expect(receiptPaymentBlockers(payment, null)).toContain("BANKING_RECEIPT_SETUP_REQUIRED");
  });
  it("requires local USD attestation for null AR, UF and Bank; never infers without it or against an explicit ref", () => {
    expect(receiptMapping({ ...ar, currency: null }, false).currency).toBeNull();
    expect(receiptMapping({ ...ar, currency: null }, true)).toMatchObject({ currency: "USD", qb_currency_ref: null });
    expect(receiptMapping({ ...clearing, currency: null }, true).currency).toBe("USD");
    // QuickBooks Desktop without multicurrency reports NO currency on Bank accounts (11 of 12 real ones, 2026-09-09).
    expect(receiptMapping({ ...ar, account_type: "Bank", currency: null }, true).currency).toBe("USD");
    expect(receiptMapping({ ...ar, account_type: "Bank", currency: null }, false).currency).toBeNull();
    expect(receiptMapping({ ...ar, account_type: "Bank", currency: "CAD" }, true).currency).toBeNull();
    expect(receiptMapping({ ...ar, currency: "CAD" }, true).currency).toBeNull();
    expect(receiptSetupSchema.safeParse({ expected_revision: 0, cut_date: "2000-01-01", ar_account_list_id: "ar",
      clearing_account_list_id: "uf", local_usd_attested: false }).success).toBe(false);
  });
});
