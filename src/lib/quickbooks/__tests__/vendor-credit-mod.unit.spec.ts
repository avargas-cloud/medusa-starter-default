import { buildVendorCreditModQbxml } from "../vendor-credit-mod";

const base = {
  txnId: "1D0AFD-1789143761",
  editSequence: "1789143761",
  vendorListId: "80001976-1",
  apAccountListId: "8000003B-1318880913",
  txnDate: "2026-09-11",
  refNumber: "VC-1002",
  memo: "RMA# · restock",
  expenseLines: [],
  itemLines: [
    { txnLineId: "1D0AFF-1789143761", itemListId: "80000ABC-1", quantity: 4, unitCostCents: 8800, amountCents: 35200 },
    { txnLineId: null, itemListId: "80000DEF-1", quantity: 1, unitCostCents: 1234, amountCents: 1234 },
  ],
};

describe("buildVendorCreditModQbxml", () => {
  it("emits the load-bearing element order and always sends VendorRef (QB: 'Transaction must have a name')", () => {
    const xml = buildVendorCreditModQbxml(base);
    const order = [
      "<VendorCreditModRq><VendorCreditMod>",
      "<TxnID>1D0AFD-1789143761</TxnID>",
      "<EditSequence>1789143761</EditSequence>",
      "<VendorRef><ListID>80001976-1</ListID></VendorRef>",
      "<APAccountRef><ListID>8000003B-1318880913</ListID></APAccountRef>",
      "<TxnDate>2026-09-11</TxnDate>",
      "<RefNumber>VC-1002</RefNumber>",
      "<Memo>RMA# · restock</Memo>",
      "<ItemLineMod>",
    ];
    let cursor = -1;
    for (const piece of order) {
      const idx = xml.indexOf(piece);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("addresses an existing line by its TxnLineID and a new line with -1, in Quantity→Cost→Amount order", () => {
    const xml = buildVendorCreditModQbxml(base);
    expect(xml).toContain(
      "<ItemLineMod><TxnLineID>1D0AFF-1789143761</TxnLineID><ItemRef><ListID>80000ABC-1</ListID></ItemRef><Quantity>4</Quantity><Cost>88.00</Cost><Amount>352.00</Amount></ItemLineMod>"
    );
    expect(xml).toContain(
      "<ItemLineMod><TxnLineID>-1</TxnLineID><ItemRef><ListID>80000DEF-1</ListID></ItemRef><Quantity>1</Quantity><Cost>12.34</Cost><Amount>12.34</Amount></ItemLineMod>"
    );
  });

  it("expense lines go BEFORE item lines and carry the account + optional memo", () => {
    const xml = buildVendorCreditModQbxml({
      ...base,
      expenseLines: [{ txnLineId: null, accountListId: "80000075-1", amountCents: 500, memo: "fee" }],
    });
    expect(xml.indexOf("<ExpenseLineMod>")).toBeLessThan(xml.indexOf("<ItemLineMod>"));
    expect(xml).toContain(
      "<ExpenseLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>80000075-1</ListID></AccountRef><Amount>5.00</Amount><Memo>fee</Memo></ExpenseLineMod>"
    );
  });

  it("refuses without TxnID / EditSequence / vendor / AP / lines", () => {
    expect(() => buildVendorCreditModQbxml({ ...base, txnId: "" })).toThrow(/TxnID/);
    expect(() => buildVendorCreditModQbxml({ ...base, editSequence: "" })).toThrow(/EditSequence/);
    expect(() => buildVendorCreditModQbxml({ ...base, vendorListId: "" })).toThrow(/vendor ListID/);
    expect(() => buildVendorCreditModQbxml({ ...base, apAccountListId: "" })).toThrow(/APAccountRef/);
    expect(() => buildVendorCreditModQbxml({ ...base, itemLines: [] })).toThrow(/at least one line/);
  });

  it("escapes XML in memo", () => {
    const xml = buildVendorCreditModQbxml({ ...base, memo: "a & b <c>" });
    expect(xml).toContain("<Memo>a &amp; b &lt;c&gt;</Memo>");
  });
});
