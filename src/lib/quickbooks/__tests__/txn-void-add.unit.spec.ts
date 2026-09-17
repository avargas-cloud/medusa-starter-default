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

describe("buildTxnVoidQbxml — delete-only types (qbXML ≤ 11.0)", () => {
  it("SalesTaxPaymentCheck goes as TxnDelRq: TxnVoidRq rejects it with 3110 on this company file (measured 09/17/2026)", () => {
    const xml = buildTxnVoidQbxml("SalesTaxPaymentCheck", "1D199F-1789667901");
    expect(xml).toContain("<TxnDelRq><TxnDelType>SalesTaxPaymentCheck</TxnDelType><TxnID>1D199F-1789667901</TxnID></TxnDelRq>");
    expect(xml).not.toContain("TxnVoidRq");
  });

  it("JournalEntry still goes as TxnVoidRq", () => {
    expect(buildTxnVoidQbxml("JournalEntry", "1D199C-1789665764")).toContain("<TxnVoidRq><TxnVoidType>JournalEntry</TxnVoidType>");
  });
});
