/**
 * The rebuild preflight decides whether a Vendor Bill may be HARD-DELETED from
 * QuickBooks. Before 2026-08-04 it asked only `IsPaid`, which is false on a
 * PARTIALLY paid bill, and leaned on an `AmountDue <= 0` arm that can never
 * fire — `AmountDue` is the invoice total in this integration, not the open
 * balance (rule of 2026-07-30). So a bill with payments applied to it was
 * cleared for deletion.
 *
 * These cases pin the distinction the fix rests on: which LinkedTxn types mean
 * "money moved", and — the one that actually bites — that an ABSENT LinkedTxn
 * key is "we could not look", never "there are none".
 */
import {
  extractBillPaymentLinks,
} from "../../lib/quickbooks/consolidator/vendor-bill-rebuild-operations";

describe("extractBillPaymentLinks", () => {
  it("returns null when QuickBooks did not send LinkedTxn at all", () => {
    // NOT an empty array: the caller must be able to tell "no payments" from
    // "the query came back without the evidence", because it is about to
    // delete an accounting document.
    expect(extractBillPaymentLinks({ TxnID: "1", IsPaid: "false" })).toBeNull();
    expect(extractBillPaymentLinks(null)).toBeNull();
    expect(extractBillPaymentLinks(undefined)).toBeNull();
  });

  it("returns an empty list when LinkedTxn is present but carries no payments", () => {
    // A Bill raised from a PO always links the PO itself and its receipts.
    // Those are normal and must not read as payments.
    const billRet = {
      TxnID: "1",
      LinkedTxn: [
        { TxnID: "po-1", TxnType: "PurchaseOrder" },
        { TxnID: "ir-1", TxnType: "ItemReceipt" },
      ],
    };
    expect(extractBillPaymentLinks(billRet)).toEqual([]);
  });

  it("detects a payment link on a bill QuickBooks still reports as unpaid", () => {
    // The exact shape of the bug: partially paid, so IsPaid is false.
    const billRet = {
      TxnID: "1",
      IsPaid: "false",
      AmountDue: "3775.15",
      LinkedTxn: [
        { TxnID: "po-1", TxnType: "PurchaseOrder" },
        { TxnID: "pay-1", TxnType: "BillPaymentCheck" },
      ],
    };
    const links = extractBillPaymentLinks(billRet);
    expect(links).toHaveLength(1);
    expect(links?.[0]).toEqual({
      txnId: "pay-1",
      txnType: "BillPaymentCheck",
    });
  });

  it("counts credit-card payments and vendor credits as money moved", () => {
    const billRet = {
      LinkedTxn: [
        { TxnID: "cc-1", TxnType: "BillPaymentCreditCard" },
        { TxnID: "vc-1", TxnType: "VendorCredit" },
      ],
    };
    expect(extractBillPaymentLinks(billRet)).toHaveLength(2);
  });

  it("accepts a single LinkedTxn object, not only an array", () => {
    // QBXML collapses a one-element list to a bare object; reading it as an
    // array would silently see zero links on exactly the bill that has one.
    const billRet = {
      LinkedTxn: { TxnID: "pay-1", TxnType: "BillPaymentCheck" },
    };
    expect(extractBillPaymentLinks(billRet)).toHaveLength(1);
  });

  it("unwraps a BillRet delivered as an array", () => {
    const billRet = [
      { LinkedTxn: [{ TxnID: "pay-1", TxnType: "BillPaymentCheck" }] },
    ];
    expect(extractBillPaymentLinks(billRet)).toHaveLength(1);
  });

  it("ignores a link with no TxnID", () => {
    const billRet = { LinkedTxn: [{ TxnType: "BillPaymentCheck" }] };
    expect(extractBillPaymentLinks(billRet)).toEqual([]);
  });
});
