import {
  buildHierarchy,
  pruneZeroRows,
  sumRoots,
  sumRootsCompare,
  type HierarchyInput,
} from "../../lib/ledger/reports/hierarchy";

function row(partial: Partial<HierarchyInput> & { list_id: string; full_name: string }): HierarchyInput {
  const name = partial.full_name.split(":").pop() ?? partial.full_name;
  return {
    name,
    account_number: null,
    parent_list_id: null,
    parent_full_name: null,
    cents: 0n,
    compare_cents: null,
    ...partial,
  };
}

describe("buildHierarchy", () => {
  it("nests by parent_list_id, indents children and rolls subtotals up to the parent", () => {
    const rows = buildHierarchy([
      row({ list_id: "c1", full_name: "Auto:Gas", parent_list_id: "p", cents: 10n }),
      row({ list_id: "p", full_name: "Auto", cents: 5n }),
      row({ list_id: "c2", full_name: "Auto:Parts", parent_list_id: "p", cents: 20n }),
    ]);
    expect(rows.map((r) => [r.full_name, r.depth, r.cents])).toEqual([
      ["Auto", 0, 35n],
      ["Auto:Gas", 1, 10n],
      ["Auto:Parts", 1, 20n],
    ]);
    expect(sumRoots(rows)).toBe(35n);
  });

  it("keeps the parent's OWN postings apart from the roll-up (children + other = parent)", () => {
    const rows = buildHierarchy([
      row({ list_id: "p", full_name: "Sales", cents: 975n }),
      row({ list_id: "c1", full_name: "Sales:LED", parent_list_id: "p", cents: 100n }),
      row({ list_id: "c2", full_name: "Sales:Ship", parent_list_id: "p", cents: 25n }),
    ]);
    const parent = rows[0]!;
    expect(parent.cents).toBe(1100n);
    expect(parent.own_cents).toBe(975n);
    expect(parent.has_children).toBe(true);
    const children = rows.filter((r) => r.depth === 1);
    expect(children.reduce((s, r) => s + r.cents, 0n) + parent.own_cents).toBe(parent.cents);
    expect(children.every((r) => !r.has_children && r.own_cents === r.cents)).toBe(true);
  });

  it("falls back to parent_full_name when parent_list_id is NULL (the QB mirror's state)", () => {
    const rows = buildHierarchy([
      row({ list_id: "p", full_name: "Loans" }),
      row({ list_id: "c", full_name: "Loans:Chase", parent_full_name: "Loans", cents: 7n }),
      row({ list_id: "g", full_name: "Loans:Chase:Principal", parent_full_name: "Loans:Chase", cents: 3n }),
    ]);
    expect(rows.map((r) => [r.list_id, r.depth, r.cents])).toEqual([
      ["p", 0, 10n],
      ["c", 1, 10n],
      ["g", 2, 3n],
    ]);
  });

  it("orders siblings by account_number first, then full_name; numberless last", () => {
    const rows = buildHierarchy([
      row({ list_id: "z", full_name: "Zeta" }),
      row({ list_id: "b", full_name: "Beta", account_number: "200" }),
      row({ list_id: "a", full_name: "Alpha", account_number: "100" }),
      row({ list_id: "m", full_name: "Mu" }),
    ]);
    expect(rows.map((r) => r.list_id)).toEqual(["a", "b", "m", "z"]);
  });

  it("degrades a dangling or cyclic parent to a root instead of throwing", () => {
    const rows = buildHierarchy([
      row({ list_id: "x", full_name: "X", parent_list_id: "missing", cents: 1n }),
      row({ list_id: "y", full_name: "Y", parent_list_id: "z", cents: 2n }),
      row({ list_id: "z", full_name: "Z", parent_list_id: "y", cents: 4n }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.depth === 0).length).toBeGreaterThanOrEqual(2);
    expect(sumRoots(rows)).toBe(7n);
  });

  it("rolls compare_cents up and keeps own_compare_cents", () => {
    const rows = buildHierarchy([
      row({ list_id: "p", full_name: "P", cents: 1n, compare_cents: 100n }),
      row({ list_id: "c", full_name: "P:C", parent_list_id: "p", cents: 2n, compare_cents: 50n }),
    ]);
    expect(rows[0]?.own_compare_cents).toBe(100n);
    expect(rows[0]?.compare_cents).toBe(150n);
  });

  it("rolls compare_cents up too, and sumRootsCompare is null when any root lacks it", () => {
    const withCompare = buildHierarchy([
      row({ list_id: "p", full_name: "P", cents: 1n, compare_cents: 100n }),
      row({ list_id: "c", full_name: "P:C", parent_list_id: "p", cents: 2n, compare_cents: 50n }),
    ]);
    expect(withCompare[0]?.compare_cents).toBe(150n);
    expect(sumRootsCompare(withCompare)).toBe(150n);
    expect(sumRootsCompare(buildHierarchy([row({ list_id: "q", full_name: "Q" })]))).toBeNull();
  });
});

describe("pruneZeroRows", () => {
  it("drops zero rows but never a parent whose subtree still has movement", () => {
    const rows = buildHierarchy([
      row({ list_id: "p", full_name: "Auto", cents: 10n }),
      row({ list_id: "c1", full_name: "Auto:Gas", parent_list_id: "p", cents: -10n }),
      row({ list_id: "c2", full_name: "Auto:Parts", parent_list_id: "p", cents: 0n }),
      row({ list_id: "z", full_name: "Zero" }),
    ]);
    // Parent nets to 0 (own 10, child −10): it must survive for its child's sake.
    expect(rows[0]?.cents).toBe(0n);
    expect(pruneZeroRows(rows).map((r) => r.list_id)).toEqual(["p", "c1"]);
  });
});
