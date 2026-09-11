import { buildTxnVoidQbxml } from "../txn-void-add";

describe("buildTxnVoidQbxml", () => {
  it("builds the exact §4 TxnVoidRq shape for each voidable type", () => {
    for (const type of [
      "VendorCredit",
      "BillPaymentCheck",
      "BillPaymentCreditCard",
    ] as const) {
      const xml = buildTxnVoidQbxml(type, "9000AAA-TXN");
      expect(xml).toContain(
        `<TxnVoidRq><TxnVoidType>${type}</TxnVoidType><TxnID>9000AAA-TXN</TxnID></TxnVoidRq>`
      );
    }
  });

  it("escapes the TxnID", () => {
    const xml = buildTxnVoidQbxml("VendorCredit", "9000<AAA>&TXN");
    expect(xml).toContain("<TxnID>9000&lt;AAA&gt;&amp;TXN</TxnID>");
  });

  it("throws without a TxnID", () => {
    expect(() => buildTxnVoidQbxml("VendorCredit", "")).toThrow(/TxnID/);
  });
});
