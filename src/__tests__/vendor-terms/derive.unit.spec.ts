import {
  deriveTermsFromVendors,
  flagNameNumberMismatch,
  type VendorTermSighting,
} from "../../lib/vendor-terms/derive";
import {
  buildCatalog,
  findTermByName,
  parseTermRow,
} from "../../lib/vendor-terms/catalog";

/**
 * The real distribution measured against production on 2026-08-01 —
 * `GROUP BY terms_ref_name, days, day_of_month` over 280 vendors that carry a
 * term. Kept verbatim (typos included) because the disagreements ARE the test.
 */
const PROD_SIGHTINGS: VendorTermSighting[] = [
  { name: "Due on receipt", days: 0, day_of_month_due: null, vendors: 116 },
  { name: "Net-30", days: 30, day_of_month_due: null, vendors: 61 },
  { name: "Net-15", days: 15, day_of_month_due: null, vendors: 27 },
  { name: "Net-10", days: 10, day_of_month_due: null, vendors: 25 },
  { name: "Net 30", days: 30, day_of_month_due: null, vendors: 14 },
  {
    name: "30% Deposit, 70% upon delivery",
    days: 30,
    day_of_month_due: null,
    vendors: 9,
  },
  { name: "Special", days: 0, day_of_month_due: null, vendors: 5 },
  { name: "Consignment", days: 90, day_of_month_due: null, vendors: 5 },
  {
    name: "50% deposit, 50% upon delivery",
    days: 0,
    day_of_month_due: null,
    vendors: 4,
  },
  { name: "Net-60", days: 60, day_of_month_due: null, vendors: 2 },
  { name: "1 Year", days: 360, day_of_month_due: null, vendors: 2 },
  { name: "30 days", days: 0, day_of_month_due: null, vendors: 1 },
  { name: "Net-90", days: 90, day_of_month_due: null, vendors: 1 },
  { name: "100% TT in Advance", days: 0, day_of_month_due: null, vendors: 1 },
  { name: "Due on receipt", days: 30, day_of_month_due: null, vendors: 1 },
  { name: "120", days: null, day_of_month_due: 20, vendors: 1 },
  { name: "1% 30-Net 45", days: 45, day_of_month_due: null, vendors: 1 },
  { name: "Prepaid", days: 0, day_of_month_due: null, vendors: 1 },
  { name: "6 Month", days: 180, day_of_month_due: null, vendors: 1 },
  { name: "10 Month", days: null, day_of_month_due: 28, vendors: 1 },
  { name: "Net-30", days: 21, day_of_month_due: null, vendors: 1 },
];

describe("vendor-terms/derive against the real production distribution", () => {
  const result = deriveTermsFromVendors(PROD_SIGHTINGS);

  it("collapses 21 sightings into 19 distinct terms", () => {
    // Two names appear twice with disagreeing rules; everything else is unique.
    expect(result.terms).toHaveLength(19);
  });

  it("keeps 'Net 30' and 'Net-30' apart — QuickBooks considers them distinct", () => {
    const spaced = result.terms.find((t) => t.name === "Net 30");
    const dashed = result.terms.find((t) => t.name === "Net-30");
    expect(spaced).toBeDefined();
    expect(dashed).toBeDefined();
    expect(spaced!.vendors).toBe(14);
  });

  it("lets the majority reading win: Net-30 is 30 days, not the lone 21", () => {
    const netThirty = result.terms.find((t) => t.name === "Net-30")!;
    expect(netThirty.days).toBe(30);
    expect(netThirty.vendors).toBe(62); // 61 + the outlier, all under one term
  });

  it("lets the majority reading win: Due on receipt is 0, not the lone 30", () => {
    const dor = result.terms.find((t) => t.name === "Due on receipt")!;
    expect(dor.days).toBe(0);
  });

  it("REPORTS both disagreements instead of hiding them", () => {
    expect(result.conflicts.map((c) => c.name).sort()).toEqual([
      "Due on receipt",
      "Net-30",
    ]);
    const netThirty = result.conflicts.find((c) => c.name === "Net-30")!;
    expect(netThirty.chosen).toMatchObject({ days: 30, vendors: 61 });
    expect(netThirty.rejected).toEqual([
      { days: 21, day_of_month_due: null, vendors: 1 },
    ]);
  });

  it("carries the two date-driven terms through untouched", () => {
    expect(result.terms.find((t) => t.name === "120")).toMatchObject({
      days: null,
      day_of_month_due: 20,
    });
    expect(result.terms.find((t) => t.name === "10 Month")).toMatchObject({
      days: null,
      day_of_month_due: 28,
    });
  });

  it("flags exactly one row across the whole production distribution", () => {
    const flags = flagNameNumberMismatch(result.terms);
    // "30 days" resolving to 0 is the only name in the company file that
    // contradicts itself. Anything more than this is noise.
    expect(flags).toEqual([{ name: "30 days", days: 0, nameSuggests: 30 }]);
  });

  it("does NOT flag the healthy names a looser regex would have caught", () => {
    const byName = Object.fromEntries(
      flagNameNumberMismatch(result.terms).map((f) => [f.name, f])
    );
    // Duration names whose number is a unit count, not a day count.
    expect(byName["1 Year"]).toBeUndefined(); // 360 days
    expect(byName["6 Month"]).toBeUndefined(); // 180 days
    // Discount-style names: the leading number is a percentage.
    expect(byName["1% 30-Net 45"]).toBeUndefined(); // 45 days
    expect(byName["50% deposit, 50% upon delivery"]).toBeUndefined();
    expect(byName["100% TT in Advance"]).toBeUndefined();
    expect(byName["30% Deposit, 70% upon delivery"]).toBeUndefined();
    // Names with no number at all.
    expect(byName["Consignment"]).toBeUndefined();
    expect(byName["Prepaid"]).toBeUndefined();
    // Names that agree with their rule.
    expect(byName["Net-30"]).toBeUndefined();
    expect(byName["Net 30"]).toBeUndefined();
    expect(byName["Net-15"]).toBeUndefined();
  });

  it("catches a contradicting Net name in every spelling", () => {
    expect(
      flagNameNumberMismatch([
        { name: "Net-45", days: 30 },
        { name: "Net 60", days: 30 },
        { name: "net90", days: 30 },
        { name: "45 Days", days: 30 },
        { name: "45d", days: 30 },
      ]).map((f) => f.nameSuggests)
    ).toEqual([45, 60, 90, 45, 45]);
  });
});

describe("vendor-terms/derive edge cases", () => {
  it("excludes a name with no rule at all rather than defaulting it to 0", () => {
    const r = deriveTermsFromVendors([
      { name: "Receiver ACC", days: null, day_of_month_due: null, vendors: 7 },
      { name: "Net-30", days: 30, day_of_month_due: null, vendors: 1 },
    ]);
    expect(r.terms.map((t) => t.name)).toEqual(["Net-30"]);
    expect(r.ruleless).toEqual(["Receiver ACC"]);
  });

  it("breaks a tie toward the smaller day count", () => {
    const r = deriveTermsFromVendors([
      { name: "Net-30", days: 30, day_of_month_due: null, vendors: 5 },
      { name: "Net-30", days: 45, day_of_month_due: null, vendors: 5 },
    ]);
    expect(r.terms[0].days).toBe(30);
    expect(r.conflicts[0].rejected[0].days).toBe(45);
  });

  it("ignores blank names", () => {
    const r = deriveTermsFromVendors([
      { name: "   ", days: 30, day_of_month_due: null, vendors: 3 },
    ]);
    expect(r.terms).toHaveLength(0);
    expect(r.ruleless).toHaveLength(0);
  });

  it("groups case- and whitespace-insensitively", () => {
    const r = deriveTermsFromVendors([
      { name: "net-30", days: 30, day_of_month_due: null, vendors: 2 },
      { name: "NET-30", days: 30, day_of_month_due: null, vendors: 3 },
    ]);
    expect(r.terms).toHaveLength(1);
    expect(r.terms[0].vendors).toBe(5);
  });

  it("returns nothing for no input", () => {
    expect(deriveTermsFromVendors([])).toEqual({
      terms: [],
      conflicts: [],
      ruleless: [],
    });
  });
});

describe("vendor-terms/catalog row mapping", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "sd_1",
    value: "Net-30",
    sort_order: 9,
    metadata: { days: 30, day_of_month_due: null, exists_in_qb: true },
    ...over,
  });

  it("maps a healthy row", () => {
    expect(parseTermRow(row())).toEqual({
      id: "sd_1",
      name: "Net-30",
      days: 30,
      day_of_month_due: null,
      due_next_month_days: null,
      exists_in_qb: true,
      qb_synced_at: null,
      sort_order: 9,
    });
  });

  it("coerces numbers that Postgres handed back as strings", () => {
    const parsed = parseTermRow(
      row({ sort_order: "9", metadata: { days: "30", day_of_month_due: null } })
    );
    expect(parsed).toMatchObject({ days: 30, sort_order: 9 });
  });

  it("rejects a row with no rule, both rules, or no name", () => {
    expect(parseTermRow(row({ metadata: {} }))).toBeNull();
    expect(
      parseTermRow(row({ metadata: { days: 30, day_of_month_due: 20 } }))
    ).toBeNull();
    expect(parseTermRow(row({ value: "  " }))).toBeNull();
    expect(parseTermRow(row({ metadata: null }))).toBeNull();
  });

  it("exists_in_qb defaults to false — never assume QB knows a term", () => {
    expect(parseTermRow(row({ metadata: { days: 30 } }))!.exists_in_qb).toBe(
      false
    );
    expect(
      parseTermRow(row({ metadata: { days: 30, exists_in_qb: "true" } }))!
        .exists_in_qb
    ).toBe(false);
  });

  it("buildCatalog surfaces rejected rows instead of dropping them", () => {
    const cat = buildCatalog([
      row(),
      row({ id: "sd_bad", value: "Broken", metadata: {} }),
    ]);
    expect(cat.options).toHaveLength(1);
    expect(cat.rejected).toEqual([{ id: "sd_bad", value: "Broken" }]);
  });

  it("findTermByName matches case and whitespace but not punctuation", () => {
    const cat = buildCatalog([row(), row({ id: "sd_2", value: "Net 30" })]);
    expect(findTermByName(cat, "  net-30 ")!.id).toBe("sd_1");
    expect(findTermByName(cat, "NET 30")!.id).toBe("sd_2");
    expect(findTermByName(cat, "Net45")).toBeNull();
    expect(findTermByName(cat, null)).toBeNull();
  });
});
