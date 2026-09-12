import {
  docLabelFor,
  glCheckJoinSql,
  payeeColumnSql,
} from "../../lib/ledger/reports/doc-labels";

describe("docLabelFor", () => {
  it("prefixes POS document families with their human word", () => {
    expect(docLabelFor("pos_invoice", "21601")).toBe("Invoice 21601");
    expect(docLabelFor("pos_credit_memo", "CM-1101")).toBe("Credit memo CM-1101");
    expect(docLabelFor("vendor_bill", "VB-1105")).toBe("Bill VB-1105");
    expect(docLabelFor("vendor_bill_payment", "BP-1063")).toBe("Bill payment BP-1063");
    expect(docLabelFor("vendor_credit", "VC-1065")).toBe("Vendor credit VC-1065");
    expect(docLabelFor("journal_entry", "JE-0003")).toBe("Journal JE-0003");
    expect(docLabelFor("check", "1042")).toBe("Check 1042");
    expect(docLabelFor("bank_check", "CHK-1042")).toBe("Check CHK-1042");
    expect(docLabelFor("bank_transfer", "TRF-3")).toBe("Transfer TRF-3");
    expect(docLabelFor("transfer", "TR-7")).toBe("Transfer TR-7");
    expect(docLabelFor("year_close", "2025")).toBe("Year close 2025");
  });

  it("hides opaque ids for kinds whose document number is an internal id", () => {
    expect(docLabelFor("customer_payment", "cpay_01KP61K4")).toBe("Customer payment");
    expect(docLabelFor("po_receipt", "por_01KZ9")).toBe("PO receipt");
    expect(docLabelFor("opening_balance", "OBE-80000057")).toBe("Opening balance");
    expect(docLabelFor("rounding_adjustment", "radj_01")).toBe("Rounding adjustment");
  });

  it("passes qb_import document numbers through (already human)", () => {
    expect(docLabelFor("qb_import", "Check 1042")).toBe("Check 1042");
    expect(docLabelFor("qb_import", "Deposit 1B4542-1768570388")).toBe("Deposit 1B4542-1768570388");
    expect(docLabelFor("qb_import", null)).toBe("QB import");
  });

  it("humanizes unknown kinds and never returns an empty label", () => {
    expect(docLabelFor("bank_fee", "F-1")).toBe("Bank fee F-1");
    expect(docLabelFor("bank_fee", null)).toBe("Bank fee");
    expect(docLabelFor(null, null)).toBe("Journal");
  });
});

describe("gl_check payee degradation", () => {
  it("omits the gl_check join and column when the table has no usable column", () => {
    expect(glCheckJoinSql(null)).toBe("");
    expect(payeeColumnSql(null)).not.toContain("gc.");
  });

  it("joins gl_check and reads the detected column when present", () => {
    expect(glCheckJoinSql("payee_name")).toContain("LEFT JOIN gl_check gc");
    expect(payeeColumnSql("payee_name")).toContain('gc."payee_name"');
  });
});
