/**
 * Unit tests for the PURE planning function — no container, no DB.
 * `reconcileCustomerGroups` (the I/O wrapper) is exercised only by the
 * static/e2e verify script, not here (needs a live container).
 */
import { planCustomerGroupReconcile } from "../reconcile-customer-groups";

const WHOLESALE = "cusgroup_01KGMKM66SZVRE4ZDZBC5862HT";
const RETAIL = "cusgroup_01KGMKM60YNYNPJRWRVDRM38K2";

describe("planCustomerGroupReconcile — add-only", () => {
  it("wholesale tier, not yet a member → adds Wholesale", () => {
    const result = planCustomerGroupReconcile({
      tier: "wholesale",
      memberGroupIds: [],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([WHOLESALE]);
  });

  it("wholesale tier, already a member → no-op", () => {
    const result = planCustomerGroupReconcile({
      tier: "wholesale",
      memberGroupIds: [WHOLESALE],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([]);
  });

  it("retail tier, no groups at all → adds Retail", () => {
    const result = planCustomerGroupReconcile({
      tier: "retail",
      memberGroupIds: [],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([RETAIL]);
  });

  it("retail tier, already in Retail → no-op", () => {
    const result = planCustomerGroupReconcile({
      tier: "retail",
      memberGroupIds: [RETAIL],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([]);
  });

  it("retail tier but already in Wholesale group → NEVER removes it, no-op", () => {
    const result = planCustomerGroupReconcile({
      tier: "retail",
      memberGroupIds: [WHOLESALE],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([]);
  });

  it("retail tier, already in SOME group (any group) → membership not empty, no-op", () => {
    // Per spec: Retail is added only when (members ∪ adds) is EMPTY — a
    // customer already in an unrelated group (e.g. tax-exempt) is not
    // "groupless", so nothing is added here.
    const result = planCustomerGroupReconcile({
      tier: "retail",
      memberGroupIds: ["cusgroup_tax_exempt"],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([]);
  });

  it("wholesale tier, in some unrelated group only → adds Wholesale", () => {
    const result = planCustomerGroupReconcile({
      tier: "wholesale",
      memberGroupIds: ["cusgroup_tax_exempt"],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    expect(result.add).toEqual([WHOLESALE]);
  });

  it("never returns a removal — result only ever grows membership", () => {
    const result = planCustomerGroupReconcile({
      tier: "wholesale",
      memberGroupIds: [RETAIL],
      wholesaleGroupId: WHOLESALE,
      retailGroupId: RETAIL,
    });
    // Retail stays; Wholesale gets added — RETAIL never appears in `add`
    // meaning "remove", because `add` is additive only by construction.
    expect(result.add).toEqual([WHOLESALE]);
  });
});
