import { reviewDate, openingAmount } from "../../lib/banking/review-date";
import { reviewHash } from "../../lib/banking/review-common";
import { ruleMatches, type ReviewRule } from "../../lib/banking/review-rule-apply";

describe("Bank review civil dates and exact money", () => {
  test.each(["2024-02-29", "2026-09-01", "1900-01-01", "2200-12-31"])("accepts civil date %s", value => {
    expect(reviewDate.parse(value)).toBe(value);
  });
  test.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-12",
    "2026-09-00", "2026-9-01", "2026-09-01T00:00:00Z", "1899-12-31", "2201-01-01"])(
    "rejects invalid or non-civil date %s", value => expect(reviewDate.safeParse(value).success).toBe(false));
  test.each(["0", "-123.45000000", "999999999999999.12345678", "0.00000001"])(
    "preserves exact amount text %s", value => expect(openingAmount.parse(value)).toBe(value));
  test.each(["1e2", "NaN", "Infinity", "1,234.50", "$123.45", "01.23", "1000000000000000", "0.000000001"])(
    "rejects unsupported amount %s", value => expect(openingAmount.safeParse(value).success).toBe(false));
});

describe("Scoped automatic rule eligibility", () => {
  const rule: ReviewRule = { id: "rule", version: 1, name: "Electricity", account_id: "bank-one", active: true,
    priority: 10, match_field: "merchant", pattern: "ACME POWER", direction: "out", currency: "USD",
    category_list_id: "qb-expense", counterparty_type: null, counterparty_id: null, counterparty_name: null };
  const source: Parameters<typeof ruleMatches>[1] = { id: "tx", account_id: "bank-one", transaction_date: "2026-09-01",
    source_version: 1, amount: "123.45", currency: "USD", name: "Bank description",
    merchant_name: "  ＡＣＭＥ   POWER bill ", setup_revision: 1, closed_revision: null, review: null };

  it("normalizes merchant width, whitespace and case", () => expect(ruleMatches(rule, source)).toBe(true));
  test.each([
    { account_id: "bank-two" }, { currency: "EUR" }, { currency: null }, { amount: "-123.45" },
    { amount: "0" }, { amount: "-0.0000" }, { merchant_name: null }, { merchant_name: "Different payee" },
  ])("does not classify outside the account/currency/direction/text scope: %j", patch => {
    expect(ruleMatches(rule, { ...source, ...patch })).toBe(false);
  });
  it("does not round tiny positive movements down to zero", () => {
    expect(ruleMatches(rule, { ...source, amount: "0.00000001" })).toBe(true);
  });
  it("uses provider debit sign and incoming credit sign deliberately", () => {
    expect(ruleMatches({ ...rule, direction: "in" }, { ...source, amount: "-123.45" })).toBe(true);
  });
  it("uses literal patterns without regex metacharacters", () => {
    expect(ruleMatches({ ...rule, pattern: "ACME.*" }, source)).toBe(false);
  });
  it("searches only the chosen field", () => {
    expect(ruleMatches({ ...rule, match_field: "description" }, source)).toBe(false);
    expect(ruleMatches({ ...rule, match_field: "description" }, { ...source, name: "ACME POWER" })).toBe(true);
  });
});

describe("Canonical review receipts and snapshot hashes", () => {
  it("ignores object insertion order recursively", () => {
    expect(reviewHash({ revision: 2, nested: { b: 2, a: 1 } }))
      .toBe(reviewHash({ nested: { a: 1, b: 2 }, revision: 2 }));
  });
  it("preserves array order and monetary precision", () => {
    expect(reviewHash(["USD", "EUR"])).not.toBe(reviewHash(["EUR", "USD"]));
    expect(reviewHash("999999999999999.00000001")).not.toBe(reviewHash("999999999999999.00000002"));
  });
  it("normalizes database Date objects to their persisted JSON form", () => {
    const date = new Date("2026-09-08T18:00:00.123Z");
    expect(reviewHash({ at: date })).toBe(reviewHash({ at: date.toISOString() }));
  });
});
