/**
 * verify-dup-sku-discount-net.ts
 *
 * Regression guard for the "duplicate-SKU inline discount doubled" bug
 * (order 2450, Inv 18973): two lines of the SAME variant at the SAME list price
 * but DIFFERENT per-line discount collapse to one `${variant}|${grossCents}` net
 * key. A scalar map let the second line overwrite the first, so BOTH lines read
 * the discounted net → QB got both ESPDO at $30.38 → invoice $30.37 short →
 * apply_payment failed QB 3210.
 *
 * The fix stores a MULTISET per key and CONSUMES the closest net per line
 * (consumeClosestNet). This tests the REAL production helper, not a copy.
 *
 * Pure — no DB, no network. Run:
 *   npx tsx src/scripts/verify/verify-dup-sku-discount-net.ts
 */
import { consumeClosestNet } from "../../lib/quickbooks/handlers/utils";

let failures = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

/**
 * Reproduce the handler's per-line net resolution for a set of lines that share
 * one net-key bucket. Each line carries its own computed net (gross − its own
 * line discount). Returns the resolved net each line ends up billing at.
 */
function resolveNets(
  bucket: number[],
  lines: { computedNet: number }[]
): number[] {
  const b = [...bucket];
  return lines.map((l) => consumeClosestNet(b, l.computedNet) ?? l.computedNet);
}

// ── Case 1: the 2450 bug — two ESPDO at gross 6075, nets {6075, 3038} ──────────
{
  const bucket = [6075, 3038]; // frozen nets from pos_invoice_item (same key)
  const lines = [
    { computedNet: 6075 }, // ESPDO #1 — no per-line discount
    { computedNet: 3038 }, // ESPDO #2 — 50% off
  ];
  const resolved = resolveNets(bucket, lines);
  const total = resolved.reduce((s, n) => s + n, 0);
  ok(
    "1. dup-SKU/same-gross: both nets preserved (not both 3038)",
    total === 9113,
    `nets=${JSON.stringify(resolved)} total=${total} (buggy scalar gave 6076)`
  );
  ok(
    "1b. each line got a distinct net",
    resolved[0] !== resolved[1],
    JSON.stringify(resolved)
  );
}

// ── Case 2: regression — no duplicates, single net per key behaves like before ─
{
  const resolved = resolveNets([4850], [{ computedNet: 4850 }]);
  ok("2. no-dup line unchanged", resolved[0] === 4850, `net=${resolved[0]}`);
}

// ── Case 3: regression — same SKU DIFFERENT gross (order 1970) → separate keys ─
// Different gross means different keys upstream, i.e. two buckets of size 1. Each
// resolves independently; simulate by resolving each against its own bucket.
{
  const a = resolveNets([17199], [{ computedNet: 17199 }]);
  const b = resolveNets([13999], [{ computedNet: 13999 }]);
  ok(
    "3. same-SKU different-gross stays distinct",
    a[0] === 17199 && b[0] === 13999,
    `${a[0]}, ${b[0]}`
  );
}

// ── Case 4: bucket smaller than lines (legacy/partial) → falls back gracefully ─
{
  const b = [3038];
  const first = consumeClosestNet(b, 3038);
  const second = consumeClosestNet(b, 6075); // bucket now empty
  ok(
    "4. empty bucket returns undefined (caller recomputes)",
    first === 3038 && second === undefined
  );
}

console.log(
  failures === 0
    ? "\n✅ ALL PASSED — duplicate-SKU discount net resolution is correct"
    : `\n❌ ${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);
