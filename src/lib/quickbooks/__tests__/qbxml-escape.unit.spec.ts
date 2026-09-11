import { escapeXml, sanitizeForQb } from "../qbxml-escape";

/**
 * QuickBooks (through the bridge) rejects ANY non-ASCII character with
 * HRESULT 0x80040400 — probed 2026-09-11 with a fake TxnID against the live
 * company file (VC-1002's real memo reproduced it; the same request parsed
 * once the memo was ASCII). These pin the folding at the boundary.
 */
describe("sanitizeForQb", () => {
  it("folds the exact memo that killed the first real VendorCreditMod", () => {
    expect(sanitizeForQb("RMA# \u00B7 Return of 6 \u00D7 SUP-MDA-300-24 J-Box")).toBe(
      "RMA# - Return of 6 x SUP-MDA-300-24 J-Box"
    );
  });

  it("strips accents instead of dropping the letter", () => {
    expect(sanitizeForQb("Devoluci\u00F3n de Jos\u00E9 Pe\u00F1a")).toBe("Devolucion de Jose Pena");
  });

  it("maps typographic punctuation to its ASCII shape", () => {
    expect(sanitizeForQb("en dash \u2013 em dash \u2014 \u201Cquotes\u201D \u2018single\u2019 \u2026")).toBe(
      "en dash - em dash - \"quotes\" 'single' ..."
    );
  });

  it("keeps the 2026-08-01 NBSP rule and drops zero-width marks and controls", () => {
    expect(sanitizeForQb("SLT\u00A0Ligthing\u200B\uFEFF\u0007")).toBe("SLT Ligthing");
  });

  it("drops what has no ASCII shape rather than shipping it", () => {
    expect(sanitizeForQb("ok \u4E2D\u6587 \uD83D\uDE00 done")).toBe("ok   done");
  });

  it("leaves printable ASCII (tabs and newlines included) untouched", () => {
    const plain = "PO-1163 / VB-1138\tqty 6\n$88.00 <ok> & \"q\"";
    expect(sanitizeForQb(plain)).toBe(plain);
  });

  it("escapeXml folds first, then escapes", () => {
    expect(escapeXml("A \u00D7 B & \u201CC\u201D")).toBe("A x B &amp; &quot;C&quot;");
  });
});
