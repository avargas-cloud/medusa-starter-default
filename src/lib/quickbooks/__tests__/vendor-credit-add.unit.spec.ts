import { buildVendorCreditAddQbxml } from "../vendor-credit-add";

const BASE_INPUT = {
  vendorListId: "80000001-VENDOR",
  apAccountListId: "80000002-AP",
  txnDate: "2026-09-10",
  refNumber: "VC-1001",
  memo: "Return of defective units",
  expenseLines: [],
  itemLines: [
    { itemListId: "80000003-ITEM", quantity: 2, unitCostCents: 500, amountCents: 1000 },
  ],
};

describe("buildVendorCreditAddQbxml", () => {
  it("wraps the envelope and emits elements in the exact §4 order", () => {
    const xml = buildVendorCreditAddQbxml(BASE_INPUT);
    expect(xml).toContain('<?qbxml version="10.0"?>');
    expect(xml).toContain("<VendorCreditAddRq><VendorCreditAdd>");
    const order = [
      "<VendorRef>",
      "<APAccountRef>",
      "<TxnDate>",
      "<RefNumber>",
      "<Memo>",
      "<ItemLineAdd>",
    ];
    let cursor = -1;
    for (const tag of order) {
      const idx = xml.indexOf(tag);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("emits ExpenseLineAdd before ItemLineAdd when both are present", () => {
    const xml = buildVendorCreditAddQbxml({
      ...BASE_INPUT,
      expenseLines: [{ accountListId: "80000004-EXP", amountCents: 250, memo: "Freight" }],
    });
    expect(xml.indexOf("<ExpenseLineAdd>")).toBeLessThan(xml.indexOf("<ItemLineAdd>"));
    expect(xml).toContain("<Amount>2.50</Amount>");
  });

  it("formats cents as dollar strings with exactly 2 decimals", () => {
    const xml = buildVendorCreditAddQbxml(BASE_INPUT);
    expect(xml).toContain("<Cost>5.00</Cost>");
    expect(xml).toContain("<Amount>10.00</Amount>");
  });

  it("escapes XML-special characters", () => {
    const specialMemo = 'Ref <"Return"> & co';
    const xml = buildVendorCreditAddQbxml({
      ...BASE_INPUT,
      memo: specialMemo,
    });
    expect(xml).not.toContain(`<Memo>${specialMemo}</Memo>`);
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&amp;");
  });

  it("converts the QuickBooks-hostile NBSP to a plain space (2026-08-01 rule)", () => {
    const nbsp = " ";
    const xml = buildVendorCreditAddQbxml({
      ...BASE_INPUT,
      memo: `Foo${nbsp}Bar`,
    });
    expect(xml).not.toContain(nbsp);
    expect(xml).toContain("<Memo>Foo Bar</Memo>");
  });

  it("throws when there is no vendor ListID", () => {
    expect(() =>
      buildVendorCreditAddQbxml({ ...BASE_INPUT, vendorListId: "" })
    ).toThrow(/vendor ListID/);
  });

  it("throws when there is no AP account ListID", () => {
    expect(() =>
      buildVendorCreditAddQbxml({ ...BASE_INPUT, apAccountListId: "" })
    ).toThrow(/APAccountRef/);
  });

  it("throws when there are no lines at all", () => {
    expect(() =>
      buildVendorCreditAddQbxml({ ...BASE_INPUT, itemLines: [], expenseLines: [] })
    ).toThrow(/at least one line/);
  });

  it("throws when an expense line has no QB account", () => {
    expect(() =>
      buildVendorCreditAddQbxml({
        ...BASE_INPUT,
        itemLines: [],
        expenseLines: [{ accountListId: "", amountCents: 100 }],
      })
    ).toThrow(/no QB account/);
  });

  it("throws when an item line has no QB item ListID", () => {
    expect(() =>
      buildVendorCreditAddQbxml({
        ...BASE_INPUT,
        itemLines: [{ itemListId: "", quantity: 1, unitCostCents: 100, amountCents: 100 }],
      })
    ).toThrow(/no QB item ListID/);
  });

  it("omits Memo entirely when null", () => {
    const xml = buildVendorCreditAddQbxml({ ...BASE_INPUT, memo: null });
    expect(xml).not.toContain("<Memo>");
  });
});
