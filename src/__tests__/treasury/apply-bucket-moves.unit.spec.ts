/**
 * applyBucketMoves — registered bucket assignments move money between splits,
 * sum-zero, and NEVER below zero on the source bucket.
 *
 * Fixture = production day 2026-09-14 under the v1 split (Operating 1,583,622)
 * with the two picks registered on 09/16: PAY-5010 → China 2,353,576 and
 * PAY-5014 → Local 107,432. v1 applied both blindly → Operating −877,386 and a
 * negative wire on screen. Type: pure unit test (no DB).
 */
import {
  applyBucketMoves,
  type BucketMove,
} from "../../api/admin/accounting/treasury/_lib/apply-bucket-moves";

const SPLITS_V1_2026_09_14 = [
  { code: "china_cogs" as const, amount_cents: 935_582 },
  { code: "local_cogs" as const, amount_cents: 462_449 },
  { code: "tax_holding" as const, amount_cents: 30_041 },
  { code: "operating" as const, amount_cents: 1_583_622 },
  { code: "reserve" as const, amount_cents: 0 },
];
const PICK_5010: BucketMove = {
  from: "operating",
  to: "china_cogs",
  cents: 2_353_576,
  ref: "cpay_5010",
};
const PICK_5014: BucketMove = {
  from: "operating",
  to: "local_cogs",
  cents: 107_432,
  ref: "cpay_5014",
};

const amount = (splits: ReadonlyArray<{ code: string; amount_cents: number }>, code: string) =>
  splits.find((s) => s.code === code)?.amount_cents ?? NaN;
const sum = (splits: ReadonlyArray<{ amount_cents: number }>) =>
  splits.reduce((a, s) => a + s.amount_cents, 0);

describe("applyBucketMoves — floor at zero on the source bucket", () => {
  it("a move larger than the source bucket is REJECTED, not applied", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [PICK_5010]);
    expect(out.rejected).toEqual([
      { ...PICK_5010, available_cents: 1_583_622 },
    ]);
    expect(out.applied).toEqual([]);
    expect(amount(out.splits, "operating")).toBe(1_583_622);
    expect(amount(out.splits, "china_cogs")).toBe(935_582);
  });

  it("09/14 as registered: PAY-5010 rejected, PAY-5014 applied, Operating ≥ 0", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [PICK_5010, PICK_5014]);
    expect(out.rejected.map((r) => r.ref)).toEqual(["cpay_5010"]);
    expect(out.applied.map((a) => a.ref)).toEqual(["cpay_5014"]);
    expect(amount(out.splits, "operating")).toBe(1_583_622 - 107_432);
    expect(amount(out.splits, "local_cogs")).toBe(462_449 + 107_432);
    expect(out.splits.every((s) => s.code === "reserve" || s.amount_cents >= 0)).toBe(true);
  });

  it("moves are sum-zero: the reconciliation invariant is untouched", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [PICK_5010, PICK_5014]);
    expect(sum(out.splits)).toBe(sum(SPLITS_V1_2026_09_14));
  });

  it("does not mutate the input splits", () => {
    const before = SPLITS_V1_2026_09_14.map((s) => ({ ...s }));
    applyBucketMoves(SPLITS_V1_2026_09_14, [PICK_5014]);
    expect(SPLITS_V1_2026_09_14).toEqual(before);
  });

  it("a move that exactly empties the source is allowed (floor is zero, not one)", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [
      { from: "operating", to: "china_cogs", cents: 1_583_622, ref: "x" },
    ]);
    expect(out.rejected).toEqual([]);
    expect(amount(out.splits, "operating")).toBe(0);
  });

  it("sequential moves see the source already reduced by earlier applied moves", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [
      { from: "operating", to: "china_cogs", cents: 1_000_000, ref: "a" },
      { from: "operating", to: "local_cogs", cents: 600_000, ref: "b" },
    ]);
    expect(out.applied.map((a) => a.ref)).toEqual(["a"]);
    expect(out.rejected).toEqual([
      { from: "operating", to: "local_cogs", cents: 600_000, ref: "b", available_cents: 583_622 },
    ]);
  });

  it("same bucket, zero/negative cents or a bucket missing from the range are skipped silently", () => {
    const out = applyBucketMoves(SPLITS_V1_2026_09_14, [
      { from: "operating", to: "operating", cents: 5, ref: "same" },
      { from: "operating", to: "china_cogs", cents: 0, ref: "zero" },
      { from: "operating", to: "china_cogs", cents: -5, ref: "neg" },
      { from: "operating", to: "not_a_bucket" as never, cents: 5, ref: "missing" },
    ]);
    expect(out.applied).toEqual([]);
    expect(out.rejected).toEqual([]);
    expect(out.skipped.map((s) => s.ref)).toEqual(["same", "zero", "neg", "missing"]);
    expect(out.splits).toEqual(SPLITS_V1_2026_09_14);
  });
});
