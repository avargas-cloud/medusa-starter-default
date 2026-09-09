import { depositSaveSchema, depositSourceKey, depositTotals } from "../../lib/banking/deposit-types";
import { openingSaveSchema, openingItemSchema } from "../../lib/banking/opening-types";

const normal = { payment_id: "cpay", amount: "3.01", expected_source_hash: "a".repeat(32) };
const opening = { opening_item_id: "lot", amount: "75.00", expected_source_hash: "b".repeat(64) };
const body = { expected_revision: 0, account_id: "bank", date: "2000-01-05", reference: "mixed", lines: [normal, opening] };

describe("typed deposit sources preserve separate monetary identities", () => {
  it("accepts the existing v7 payment request unchanged and mixed v10 sources", () => {
    expect(depositSaveSchema.parse({ ...body, lines: [normal] }).lines).toEqual([normal]);
    expect(depositSaveSchema.parse(body).lines).toEqual([normal, opening]);
  });
  it.each([
    { ...opening, payment_id: "cpay" }, { ...normal, opening_item_id: "lot" },
    { amount: "1.00", expected_source_hash: "a".repeat(32) },
    { ...opening, expected_source_hash: "a".repeat(32) },
    { ...normal, expected_source_hash: "b".repeat(64) },
    { ...normal, source_type: "opening_item" },
  ])("rejects ambiguous or forged source shape %j", line => {
    expect(depositSaveSchema.safeParse({ ...body, lines: [line] }).success).toBe(false);
  });
  it("sums physical cents from mixed sources exactly, including the new fee", () => {
    expect(depositTotals([normal, opening], "2.01"))
      .toEqual({ gross_amount: "78.01", fee_amount: "2.01", net_amount: "76.00" });
  });
  it("never treats a source ID from another namespace as the same receipt", () => {
    expect(depositSourceKey({ payment_id: "same" })).not.toBe(depositSourceKey({ opening_item_id: "same" }));
    expect(depositTotals([{ payment_id: "same", amount: "1.00" }, { opening_item_id: "same", amount: "2.00" }], "0"))
      .toEqual({ gross_amount: "3.00", fee_amount: "0.00", net_amount: "3.00" });
  });
  it.each([[normal, normal], [opening, opening]])("rejects repeated monetary identity even if split into lines", lines => {
    expect(() => depositTotals(lines, "0")).toThrow("BANKING_DEPOSIT_LINES_INVALID");
  });
  it.each([{ payment_id: "cpay", opening_item_id: "lot" }, {}, { payment_id: null, opening_item_id: null }])
    ("rejects invalid internal identity before persistence %j", line => {
      expect(() => depositTotals([{ ...line, amount: "1.00" }], "0")).toThrow("BANKING_DEPOSIT_LINES_INVALID");
    });
  it("supports a partial opening remnant without rounding away a cent", () => {
    expect(depositTotals([{ ...opening, amount: "0.01" }], "0").gross_amount).toBe("0.01");
    expect(() => depositTotals([{ ...opening, amount: "0.001" }], "0")).toThrow("BANKING_DEPOSIT_AMOUNT_INVALID");
    expect(() => depositTotals([{ ...opening, amount: "0" }], "0")).toThrow("BANKING_DEPOSIT_AMOUNT_INVALID");
  });
});

describe("opening evidence input distinguishes unknown, zero and overdraft", () => {
  const bank = { expected_revision: 0, kind: "bank", bank_account_id: "bank", book_balance_cents: null,
    statement_balance_cents: null, items: [] };
  it("preserves unknown rather than coercing it to an attested zero", () => {
    expect(openingSaveSchema.parse(bank).book_balance_cents).toBeNull();
    expect(openingSaveSchema.parse({ ...bank, book_balance_cents: 0 }).book_balance_cents).toBe(0);
    expect(openingSaveSchema.safeParse({ ...bank, book_balance_cents: undefined }).success).toBe(false);
  });
  it("accepts an evidenced overdraft but forbids fractional cents and unsafe totals", () => {
    expect(openingSaveSchema.parse({ ...bank, book_balance_cents: -10001 }).book_balance_cents).toBe(-10001);
    for (const amount of [0.1, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
      expect(openingSaveSchema.safeParse({ ...bank, book_balance_cents: amount }).success).toBe(false);
    }
  });
  it("accepts manual legacy money without creating a customer payment", () => {
    const item = openingItemSchema.parse({ kind: "uf_receipt", original_day: "1999-12-31", amount_cents: 20000,
      external_key: "CHECK-012", reference: "Pending remnant" });
    expect(item.payment_id).toBeUndefined();
    expect(item.amount_cents).toBe(20000);
  });
});
