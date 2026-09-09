import { depositCents, depositTotals, depositSaveSchema } from "../../lib/banking/deposit-types";

describe("Exact bank deposit composition", () => {
  it("preserves cents above the JavaScript safe integer boundary", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ payment_id: `p${i}`, amount: "9999999999999.99" }));
    expect(depositTotals(lines, "0.01")).toEqual({ gross_amount: "999999999999999.00", fee_amount: "0.01", net_amount: "999999999999998.99" });
  });
  it("sums the displayed receipts and subtracts the documented fee exactly", () => {
    expect(depositTotals([{ payment_id: "a", amount: "0.10" }, { payment_id: "b", amount: "0.20" }], "0.01"))
      .toEqual({ gross_amount: "0.30", fee_amount: "0.01", net_amount: "0.29" });
  });
  test.each(["-1", "0.001", "1e2", "NaN", "01.20", "1,000.00", ""]) ("rejects ambiguous or fractional-cent input %s", value => {
    expect(() => depositCents(value)).toThrow();
  });
  test.each(["1.00", "1.01"])("rejects fees consuming the entire deposit: %s", fee => {
    expect(() => depositTotals([{ payment_id: "a", amount: "1.00" }], fee)).toThrow();
  });
  it("rejects repeated receipts instead of reserving the same source twice", () => {
    expect(() => depositTotals([{ payment_id: "a", amount: "1" }, { payment_id: "a", amount: "1" }], "0")).toThrow();
  });
  it("rejects zero-value receipt lines", () => {
    expect(() => depositTotals([{ payment_id: "a", amount: "0" }], "0")).toThrow();
  });
  it("rejects a date that does not exist", () => {
    expect(depositSaveSchema.safeParse({ expected_revision: 0, account_id: "a", date: "2026-02-29",
      reference: "D", lines: [{ payment_id: "p", amount: "1", expected_source_hash: "a".repeat(32) }] }).success).toBe(false);
  });
});
