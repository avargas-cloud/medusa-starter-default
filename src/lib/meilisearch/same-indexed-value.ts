/**
 * Is this indexed value the same as what the database says?
 *
 * Lives on its own because it is not specific to any index. It started inside
 * `audit-orders-index.ts`, picked up a second consumer in the vendors audit, and
 * a shared helper reached through a module named after one entity is how the next
 * person ends up writing their own copy.
 *
 * The point is to absorb the sloppiness a value survives a round trip as, so a
 * drift report only contains real drift. Money and timestamps come back from
 * query.graph as string or BigNumber and from Meili as number; "missing"
 * serializes as "" on one side and null on the other. Neither is drift, and a
 * report that cries wolf about them is a report nobody reads.
 *
 * KNOWN OVERLAP, deliberately not merged yet: `drift-reconciler.ts` has a private
 * `valuesEqual` doing the same job for the 5-minute sweep. The only behavioural
 * difference is the numeric tolerance below. Checked 2026-07-29 — no reconciler
 * audits a dollars-denominated float (order `total_cents` is integer cents,
 * inventory stocks are integers, customer `default_tax` is a string, product and
 * vendor fields are strings/booleans) — so merging them looks safe. It is still a
 * semantics change to a production sweep across four entities, so it needs its own
 * decision and its own measurement rather than riding along with a file move.
 */

/** Same value, allowing for how it survives a round trip through the index. */
export function sameIndexedValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;

  if (typeof expected === "number" || typeof actual === "number") {
    const a = Number(expected);
    const b = Number(actual);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 0.01;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return false;
    const sa = [...expected].sort();
    const sb = [...actual].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  const empty = (v: unknown) => v === "" || v === null || v === undefined;
  return empty(expected) && empty(actual);
}
