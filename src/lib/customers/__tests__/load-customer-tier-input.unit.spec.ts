/**
 * Unit test for the loader's ROW MAPPING only — no real DB, a fake `knex`
 * stub returns canned rows for `.raw()`. Exercises the non-trivial mapping
 * rules: non-object metadata → null, missing row → null, group rows with a
 * null id filtered out (defends against the `FILTER (WHERE cg.id IS NOT
 * NULL)` guard in the SQL ever regressing).
 */
import { loadCustomerTierInput } from "../load-customer-tier-input";

function containerWithRows(rows: any[]) {
  return {
    resolve: () => ({
      raw: async () => ({ rows }),
    }),
  };
}

describe("loadCustomerTierInput — row mapping", () => {
  it("no row (customer not found) → null", async () => {
    const result = await loadCustomerTierInput(containerWithRows([]), "cus_x");
    expect(result).toBeNull();
  });

  it("object metadata passes through", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([
        { metadata: { price_level: "Wholesale" }, groups: [] },
      ]),
      "cus_x"
    );
    expect(result?.metadata).toEqual({ price_level: "Wholesale" });
  });

  it("non-object (legacy scalar) metadata → null", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([{ metadata: "legacy-string", groups: [] }]),
      "cus_x"
    );
    expect(result?.metadata).toBeNull();
  });

  it("null metadata stays null", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([{ metadata: null, groups: [] }]),
      "cus_x"
    );
    expect(result?.metadata).toBeNull();
  });

  it("array metadata (not a plain object) → null", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([{ metadata: [1, 2, 3], groups: [] }]),
      "cus_x"
    );
    expect(result?.metadata).toBeNull();
  });

  it("groups: '[]' coalesced empty-array case maps to []", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([{ metadata: null, groups: [] }]),
      "cus_x"
    );
    expect(result?.groups).toEqual([]);
  });

  it("groups rows map id/name straight through", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([
        {
          metadata: null,
          groups: [{ id: "cusgroup_1", name: "Wholesale" }],
        },
      ]),
      "cus_x"
    );
    expect(result?.groups).toEqual([{ id: "cusgroup_1", name: "Wholesale" }]);
  });

  it("a group row with a null/missing id is filtered out (defensive)", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([
        {
          metadata: null,
          groups: [
            { id: null, name: null },
            { id: "cusgroup_1", name: "Retail" },
          ],
        },
      ]),
      "cus_x"
    );
    expect(result?.groups).toEqual([{ id: "cusgroup_1", name: "Retail" }]);
  });

  it("a group row with a null name maps to empty string, not null", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([
        { metadata: null, groups: [{ id: "cusgroup_1", name: null }] },
      ]),
      "cus_x"
    );
    expect(result?.groups).toEqual([{ id: "cusgroup_1", name: "" }]);
  });

  it("non-array groups value (defensive) maps to []", async () => {
    const result = await loadCustomerTierInput(
      containerWithRows([{ metadata: null, groups: "not-an-array" }]),
      "cus_x"
    );
    expect(result?.groups).toEqual([]);
  });
});
