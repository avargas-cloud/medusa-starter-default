import { resolveVendorBillPaymentTerms } from "../../lib/purchase-orders/vendor-bill-payment-terms";

/**
 * What a new vendor bill inherits from its vendor.
 *
 * The case that matters most here is the one that returns NOTHING: a vendor
 * whose stored day count contradicts the term it names. Producing a name there
 * would launder a contradiction into a record that looks settled, which is the
 * same call `backfill-vendor-bill-term-name.ts` makes for the same reason. One
 * such vendor exists in production today.
 */

interface Row {
  payment_terms_days: string | null;
  terms_ref_name: string | null;
}

/**
 * Answers by which table the SQL names, because the resolver issues TWO very
 * different queries against the same connection — the vendor row and the terms
 * catalog. A fake that ignored the SQL would return the vendor row to the
 * catalog read and the test would pass on a resolver that never looked a term
 * up at all.
 */
function fakeKnex(vendor: Row | null) {
  const calls: string[] = [];
  return {
    calls,
    raw: (sql: string): Promise<{ rows: unknown[] }> => {
      calls.push(sql);
      if (sql.includes("FROM qb_vendor")) {
        return Promise.resolve({ rows: vendor ? [vendor] : [] });
      }
      if (sql.includes("FROM system_defaults")) {
        return Promise.resolve({
          rows: [
            { id: "t1", value: "Net-30", sort_order: 1, metadata: { days: 30 } },
            { id: "t2", value: "Net-21", sort_order: 2, metadata: { days: 21 } },
            {
              id: "t3",
              value: "Due on receipt",
              sort_order: 3,
              metadata: { days: 0 },
            },
            // Carries no rule at all — the catalog rejects it, so a vendor
            // naming it must come back nameless rather than "matched".
            { id: "t4", value: "Broken", sort_order: 4, metadata: {} },
          ],
        });
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe("resolveVendorBillPaymentTerms", () => {
  it("returns both halves when the vendor's term agrees with its day count", async () => {
    const knex = fakeKnex({ payment_terms_days: "30", terms_ref_name: "Net-30" });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 30,
      name: "Net-30",
    });
  });

  it("matches the catalog ignoring case and whitespace, and returns the CATALOG spelling", async () => {
    const knex = fakeKnex({ payment_terms_days: "21", terms_ref_name: " net-21 " });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 21,
      name: "Net-21",
    });
  });

  it("keeps the days and drops the name when the two contradict each other", async () => {
    // The Goodlite shape: QuickBooks holds "Due on receipt", our day count says
    // 30. The due date still has to be computed, so the days survive.
    const knex = fakeKnex({
      payment_terms_days: "30",
      terms_ref_name: "Due on receipt",
    });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 30,
      name: null,
    });
  });

  it("drops the name when the catalog has no such term", async () => {
    const knex = fakeKnex({
      payment_terms_days: "30",
      terms_ref_name: "Net 30 (retired spelling)",
    });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 30,
      name: null,
    });
  });

  it("drops the name when the catalog term carries no rule to agree with", async () => {
    const knex = fakeKnex({ payment_terms_days: "30", terms_ref_name: "Broken" });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 30,
      name: null,
    });
  });

  it("falls back to due-on-receipt with no name when the vendor names no term", async () => {
    const knex = fakeKnex({ payment_terms_days: null, terms_ref_name: null });
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 0,
      name: null,
    });
  });

  it("treats a blank term name as no term", async () => {
    const knex = fakeKnex({ payment_terms_days: "0", terms_ref_name: "   " });
    const result = await resolveVendorBillPaymentTerms(knex, "qbvnd_1");
    expect(result).toEqual({ days: 0, name: null });
    // And it never bothered reading the catalog.
    expect(knex.calls.some((s) => s.includes("system_defaults"))).toBe(false);
  });

  it("rejects a day count outside the accepted range instead of storing it", async () => {
    const knex = fakeKnex({ payment_terms_days: "9999", terms_ref_name: "Net-30" });
    // 9999 is not a term anyone negotiated; falling back to 0 keeps the bill
    // due now rather than in 27 years, and the name goes with it.
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_1")).toEqual({
      days: 0,
      name: null,
    });
  });

  it("asks nothing at all when there is no vendor", async () => {
    const knex = fakeKnex(null);
    expect(await resolveVendorBillPaymentTerms(knex, null)).toEqual({
      days: 0,
      name: null,
    });
    expect(knex.calls).toHaveLength(0);
  });

  it("returns the default when the vendor id matches no live row", async () => {
    const knex = fakeKnex(null);
    expect(await resolveVendorBillPaymentTerms(knex, "qbvnd_gone")).toEqual({
      days: 0,
      name: null,
    });
  });
});
