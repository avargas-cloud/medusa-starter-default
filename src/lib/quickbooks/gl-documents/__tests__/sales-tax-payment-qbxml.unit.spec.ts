import { buildSalesTaxPaymentCheckAddQbxml } from "../qbxml-builders";

/**
 * Forma medida en producción el 09/17/2026 (SalesTaxPaymentCheckQuery de
 * 1B44DA-1768504629): PayeeEntityRef FL DOR, BankAccountRef Regions 1416,
 * RefNumber 20000664229, línea 1 ItemSalesTaxRef "Sale Tax 7%" 6292.38, línea 2
 * sin item −30.00, Amount del cheque 6262.38. El builder tiene que emitir
 * exactamente esa forma, en el orden del schema qbXML 11.0 — SIN Memo, que
 * recién existe en 12.0 y este QuickBooks no acepta (sondeado 09/17/2026).
 */
describe("SalesTaxPaymentCheckAdd qbXML", () => {
  const january = {
    payeeListId: "80000042-1338583015",
    txnDate: "2026-01-16",
    bankAccountListId: "80000167-1684269278",
    refNumber: "20000664229",
    lines: [
      { itemSalesTaxListId: "8000010E-1340914624", amountCents: 629238n },
      { itemSalesTaxListId: null, amountCents: -3000n },
    ],
  };

  it("emits the two-line January shape byte for byte", () => {
    const xml = buildSalesTaxPaymentCheckAddQbxml(january);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
        "<SalesTaxPaymentCheckAddRq><SalesTaxPaymentCheckAdd>" +
        "<PayeeEntityRef><ListID>80000042-1338583015</ListID></PayeeEntityRef>" +
        "<TxnDate>2026-01-16</TxnDate>" +
        "<BankAccountRef><ListID>80000167-1684269278</ListID></BankAccountRef>" +
        "<RefNumber>20000664229</RefNumber>" +
        "<SalesTaxPaymentCheckLineAdd><ItemSalesTaxRef><ListID>8000010E-1340914624</ListID></ItemSalesTaxRef><Amount>6292.38</Amount></SalesTaxPaymentCheckLineAdd>" +
        "<SalesTaxPaymentCheckLineAdd><Amount>-30.00</Amount></SalesTaxPaymentCheckLineAdd>" +
        "</SalesTaxPaymentCheckAdd></SalesTaxPaymentCheckAddRq>" +
        "</QBXMLMsgsRq></QBXML>"
    );
  });

  it("never emits a Memo (qbXML ≤ 11.0 rejects the whole request with 0x80040400)", () => {
    expect(buildSalesTaxPaymentCheckAddQbxml(january)).not.toContain("<Memo>");
  });

  it("without a RefNumber it emits IsToBePrinted=false (the two are mutually exclusive in the schema)", () => {
    const xml = buildSalesTaxPaymentCheckAddQbxml({ ...january, refNumber: null, lines: [january.lines[0]!] });
    expect(xml).toContain("<BankAccountRef><ListID>80000167-1684269278</ListID></BankAccountRef><IsToBePrinted>false</IsToBePrinted><SalesTaxPaymentCheckLineAdd>");
    expect(xml).not.toContain("<RefNumber>");
  });

  it("rejects: no lines, first line without the tax item, a zero line, a non-positive total", () => {
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, lines: [] })).toThrow(/at least one/);
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, lines: [january.lines[1]!] })).toThrow(/line 1 must carry/);
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, lines: [january.lines[0]!, { amountCents: 0n }] })).toThrow(/is zero/);
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, lines: [january.lines[0]!, { amountCents: -629238n }] })).toThrow(/must be positive/);
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, payeeListId: "" })).toThrow(/PayeeEntityRef/);
    expect(() => buildSalesTaxPaymentCheckAddQbxml({ ...january, txnDate: "01/16/2026" })).toThrow(/TxnDate/);
  });
});
