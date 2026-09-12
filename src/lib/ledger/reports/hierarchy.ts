/**
 * Chart-of-accounts tree for the P&L / balance sheet. Parent resolution is by
 * `parent_list_id` first; the QB mirror in this base carries it NULL on every
 * row while `parent_full_name` is populated on the 228 sub-accounts, so the
 * fallback resolves the parent by its `full_name`. Pure: no I/O.
 */
export interface HierarchyInput {
  list_id: string;
  name: string;
  full_name: string;
  account_number: string | null;
  parent_list_id: string | null;
  parent_full_name: string | null;
  cents: bigint;
  compare_cents: bigint | null;
}

export interface HierarchyRow {
  list_id: string;
  account_number: string | null;
  name: string;
  full_name: string;
  depth: number;
  /** Own movement plus every descendant's — a parent shows its subtotal. */
  cents: bigint;
  compare_cents: bigint | null;
}

function siblingOrder(a: HierarchyInput, b: HierarchyInput): number {
  const an = a.account_number ?? "";
  const bn = b.account_number ?? "";
  if (an !== bn) {
    if (!an) return 1;
    if (!bn) return -1;
    return an < bn ? -1 : 1;
  }
  return a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0;
}

export function resolveParentListId(
  row: Pick<HierarchyInput, "parent_list_id" | "parent_full_name" | "list_id">,
  byListId: ReadonlyMap<string, HierarchyInput>,
  byFullName: ReadonlyMap<string, HierarchyInput>
): string | null {
  if (row.parent_list_id && byListId.has(row.parent_list_id)) {
    return row.parent_list_id === row.list_id ? null : row.parent_list_id;
  }
  if (row.parent_full_name) {
    const parent = byFullName.get(row.parent_full_name);
    if (parent && parent.list_id !== row.list_id) return parent.list_id;
  }
  return null;
}

/**
 * Flattens the tree in display order (parents before children, siblings by
 * account_number then full_name) with `depth` and rolled-up subtotals. Any
 * cycle or dangling parent degrades to a root — a report never throws over a
 * malformed mirror row.
 */
export function buildHierarchy(
  rows: readonly HierarchyInput[]
): HierarchyRow[] {
  const byListId = new Map(rows.map((r) => [r.list_id, r]));
  const byFullName = new Map(rows.map((r) => [r.full_name, r]));
  const children = new Map<string | null, HierarchyInput[]>();
  for (const row of rows) {
    const parent = resolveParentListId(row, byListId, byFullName);
    const bucket = children.get(parent) ?? [];
    children.set(parent, [...bucket, row]);
  }
  for (const bucket of children.values()) bucket.sort(siblingOrder);

  const out: HierarchyRow[] = [];
  const visited = new Set<string>();

  const walk = (
    row: HierarchyInput,
    depth: number
  ): { cents: bigint; compare: bigint | null } => {
    visited.add(row.list_id);
    const index = out.length;
    const own: HierarchyRow = {
      list_id: row.list_id,
      account_number: row.account_number,
      name: row.name,
      full_name: row.full_name,
      depth,
      cents: row.cents,
      compare_cents: row.compare_cents,
    };
    out.push(own);
    let cents = row.cents;
    let compare = row.compare_cents;
    for (const child of children.get(row.list_id) ?? []) {
      if (visited.has(child.list_id)) continue;
      const sub = walk(child, depth + 1);
      cents += sub.cents;
      if (compare !== null && sub.compare !== null) compare += sub.compare;
    }
    out[index] = { ...own, cents, compare_cents: compare };
    return { cents, compare };
  };

  for (const root of children.get(null) ?? []) walk(root, 0);
  // Rows whose parent chain is a cycle never reached a root: emit them as roots.
  for (const row of [...rows].sort(siblingOrder)) {
    if (!visited.has(row.list_id)) walk(row, 0);
  }
  return out;
}

export function sumRoots(rows: readonly HierarchyRow[]): bigint {
  return rows
    .filter((r) => r.depth === 0)
    .reduce((acc, r) => acc + r.cents, 0n);
}

export function sumRootsCompare(rows: readonly HierarchyRow[]): bigint | null {
  const roots = rows.filter((r) => r.depth === 0);
  if (roots.some((r) => r.compare_cents === null)) return null;
  return roots.reduce((acc, r) => acc + (r.compare_cents ?? 0n), 0n);
}
