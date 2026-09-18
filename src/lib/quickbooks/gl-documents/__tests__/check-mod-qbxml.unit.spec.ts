import {
  buildCheckModQbxml,
  buildCreditCardChargeModQbxml,
  buildGlDocumentQueryQbxml,
  GL_MOD_CAPABLE_TXN_TYPES,
  glQbModResponseTag,
  glQbQueryResponseTag,
} from "../qbxml-mod-builders";

/**
 * check-revise-20260918 — CheckMod / CreditCardChargeMod de un cheque corregido
 * en el lugar. El orden de elementos es load-bearing (0x80040400); se afirma
 * byte a byte. Sin TxnLineID guardados el Mod re-manda el set completo como líneas
 * nuevas (`TxnLineID -1`; las no mencionadas se borran). NUNCA `ClearExpenseLines`:
 * parsea pero QB lo rechaza con 3151 en un CheckMod real (CHK-0999, 09/18/2026).
 */
const ENVELOPE_OPEN =
  '<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">';
const ENVELOPE_CLOSE = "</QBXMLMsgsRq></QBXML>";

const base = {
  txnId: "1C8E6D-1782909720",
  editSequence: "1782909720",
  bankAccountListId: "80000167-1684269278",
  payeeListId: "80000042-1338583015",
  txnDate: "2026-09-01",
  refNumber: "1042",
  memo: "Health insurance — Sept",
  lines: [
    { accountListId: "80000090-1", amountCents: 6000n, memo: "MED*UNIVERSITY OF MI", customerListId: null },
    { accountListId: "80000091-1", amountCents: 1250n, memo: null, customerListId: "8000AAAA-1", billable: true },
  ],
};

describe("CheckMod qbXML", () => {
  it("emits TxnID → EditSequence → AccountRef → PayeeEntityRef → RefNumber → TxnDate → Memo → IsToBePrinted → ExpenseLineMod* (probed 2026-09-18)", () => {
    expect(buildCheckModQbxml({ ...base, isToBePrinted: false })).toBe(
      ENVELOPE_OPEN +
        "<CheckModRq><CheckMod>" +
        "<TxnID>1C8E6D-1782909720</TxnID>" +
        "<EditSequence>1782909720</EditSequence>" +
        "<AccountRef><ListID>80000167-1684269278</ListID></AccountRef>" +
        "<PayeeEntityRef><ListID>80000042-1338583015</ListID></PayeeEntityRef>" +
        "<RefNumber>1042</RefNumber>" +
        "<TxnDate>2026-09-01</TxnDate>" +
        "<Memo>Health insurance - Sept</Memo>" +
        "<IsToBePrinted>false</IsToBePrinted>" +
        "<ExpenseLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>80000090-1</ListID></AccountRef><Amount>60.00</Amount><Memo>MED*UNIVERSITY OF MI</Memo></ExpenseLineMod>" +
        "<ExpenseLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>80000091-1</ListID></AccountRef><Amount>12.50</Amount><CustomerRef><ListID>8000AAAA-1</ListID></CustomerRef><BillableStatus>Billable</BillableStatus></ExpenseLineMod>" +
        "</CheckMod></CheckModRq>" +
        ENVELOPE_CLOSE
    );
  });

  it("omits PayeeEntityRef and RefNumber when absent (free payee travels in the memo; expense without number)", () => {
    const xml = buildCheckModQbxml({ ...base, payeeListId: null, refNumber: null, isToBePrinted: true });
    expect(xml).not.toContain("<PayeeEntityRef>");
    expect(xml).not.toContain("<RefNumber>");
    expect(xml).toContain("<IsToBePrinted>true</IsToBePrinted>");
    // TxnDate must still come right after AccountRef when payee and number are missing.
    expect(xml.indexOf("</AccountRef><TxnDate>")).toBeGreaterThan(0);
  });

  it("uses an existing TxnLineID when the caller has one", () => {
    const xml = buildCheckModQbxml({
      ...base,
      isToBePrinted: false,
      lines: [{ ...base.lines[0]!, txnLineId: "1C8E6E-1782909720" }],
    });
    expect(xml).toContain("<TxnLineID>1C8E6E-1782909720</TxnLineID>");
    expect(xml).not.toContain("<TxnLineID>-1</TxnLineID>");
  });

  it("refuses a Mod without TxnID, without EditSequence, without lines or with a non-positive total", () => {
    expect(() => buildCheckModQbxml({ ...base, isToBePrinted: false, txnId: "" })).toThrow(/TxnID/);
    expect(() => buildCheckModQbxml({ ...base, isToBePrinted: false, editSequence: "" })).toThrow(/EditSequence/);
    expect(() => buildCheckModQbxml({ ...base, isToBePrinted: false, lines: [] })).toThrow(/at least one/);
    expect(() =>
      buildCheckModQbxml({ ...base, isToBePrinted: false, lines: [{ accountListId: "x", amountCents: -100n }] })
    ).toThrow(/total must be positive/);
    expect(() => buildCheckModQbxml({ ...base, isToBePrinted: false, txnDate: "09/01/2026" })).toThrow(/YYYY-MM-DD/);
  });

  it("folds free text to 7-bit ASCII (QuickBooks rejects any other byte)", () => {
    const xml = buildCheckModQbxml({ ...base, isToBePrinted: false, memo: "Café — señor <&>" });
    // eslint-disable-next-line no-control-regex -- the assertion is exactly "no byte above 0x7F"
    expect(/[^\x00-\x7F]/.test(xml)).toBe(false);
    expect(xml).toContain("<Memo>Cafe - senor &lt;&amp;&gt;</Memo>");
  });
});

describe("CreditCardChargeMod qbXML", () => {
  it("emits TxnDate BEFORE RefNumber (like its Add) and no IsToBePrinted", () => {
    expect(buildCreditCardChargeModQbxml(base)).toBe(
      ENVELOPE_OPEN +
        "<CreditCardChargeModRq><CreditCardChargeMod>" +
        "<TxnID>1C8E6D-1782909720</TxnID>" +
        "<EditSequence>1782909720</EditSequence>" +
        "<AccountRef><ListID>80000167-1684269278</ListID></AccountRef>" +
        "<PayeeEntityRef><ListID>80000042-1338583015</ListID></PayeeEntityRef>" +
        "<TxnDate>2026-09-01</TxnDate>" +
        "<RefNumber>1042</RefNumber>" +
        "<Memo>Health insurance - Sept</Memo>" +
        "<ExpenseLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>80000090-1</ListID></AccountRef><Amount>60.00</Amount><Memo>MED*UNIVERSITY OF MI</Memo></ExpenseLineMod>" +
        "<ExpenseLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>80000091-1</ListID></AccountRef><Amount>12.50</Amount><CustomerRef><ListID>8000AAAA-1</ListID></CustomerRef><BillableStatus>Billable</BillableStatus></ExpenseLineMod>" +
        "</CreditCardChargeMod></CreditCardChargeModRq>" +
        ENVELOPE_CLOSE
    );
    expect(buildCreditCardChargeModQbxml(base)).not.toContain("IsToBePrinted");
  });

  it("never emits ClearExpenseLines (QuickBooks 3151 on a real CheckMod / CreditCardChargeMod)", () => {
    expect(buildCheckModQbxml({ ...base, isToBePrinted: false })).not.toContain("ClearExpenseLines");
    expect(buildCreditCardChargeModQbxml(base)).not.toContain("ClearExpenseLines");
  });
});

describe("query + tags", () => {
  it("builds the <Tipo>QueryRq by TxnID the dispatcher sends for a fresh EditSequence", () => {
    expect(buildGlDocumentQueryQbxml("Check", "1C8E6D-1782909720")).toBe(
      ENVELOPE_OPEN + "<CheckQueryRq><TxnID>1C8E6D-1782909720</TxnID></CheckQueryRq>" + ENVELOPE_CLOSE
    );
    expect(() => buildGlDocumentQueryQbxml("Check", "")).toThrow(/TxnID/);
  });

  it("derives the response tags from the type and only Check/CreditCardCharge are Mod-capable", () => {
    expect(glQbModResponseTag("CreditCardCharge")).toBe("CreditCardChargeModRs");
    expect(glQbQueryResponseTag("Check")).toBe("CheckQueryRs");
    expect([...GL_MOD_CAPABLE_TXN_TYPES]).toEqual(["Check", "CreditCardCharge"]);
  });
});
