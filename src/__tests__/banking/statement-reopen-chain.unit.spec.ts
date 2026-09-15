import {
  chainHash,
  chainMonths,
  orderReopenChain,
  type ChainStatement,
} from "../../lib/banking/statement-reopen-chain";

/**
 * Reopening statement N reopens N+1…last of the SAME account, latest first, plus
 * every closed Month Close that covers any of them — as one plan whose hash the
 * operator confirms. Decided 2026-09-15 (automatic chain, close permission).
 */
const s = (
  id: string,
  from: string,
  to: string,
  revision = 1
): ChainStatement => ({ id, from, to, revision });

describe("orderReopenChain", () => {
  it("puts later statements first (newest → oldest) and the target last", () => {
    const target = s("jul", "2026-07-01", "2026-07-31");
    const later = [
      s("aug", "2026-08-01", "2026-08-31"),
      s("sep", "2026-09-01", "2026-09-30"),
    ];
    expect(orderReopenChain(target, later).map((x) => x.id)).toEqual([
      "sep",
      "aug",
      "jul",
    ]);
  });
  it("a target with nothing after it is a chain of one", () => {
    const target = s("aug", "2026-08-01", "2026-08-31");
    expect(orderReopenChain(target, [])).toEqual([target]);
  });
  it("never lets the target appear twice even if the loader returned it", () => {
    const target = s("jul", "2026-07-01", "2026-07-31");
    expect(orderReopenChain(target, [target]).map((x) => x.id)).toEqual(["jul"]);
  });
});

describe("chainMonths", () => {
  it("lists every calendar month any statement of the chain touches, once, ascending", () => {
    const chain = [
      s("aug", "2026-08-01", "2026-08-31"),
      s("jun-jul", "2026-06-15", "2026-07-14"),
      s("may", "2026-05-01", "2026-05-31"),
    ];
    expect(chainMonths(chain)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
  });
  it("a statement inside one month yields that month only", () => {
    expect(chainMonths([s("x", "2026-07-03", "2026-07-28")])).toEqual(["2026-07"]);
  });
  it("crosses a year boundary", () => {
    expect(chainMonths([s("x", "2025-12-31", "2026-01-31")])).toEqual([
      "2025-12",
      "2026-01",
    ]);
  });
});

describe("chainHash", () => {
  const plan = {
    statements: [s("aug", "2026-08-01", "2026-08-31", 3), s("jul", "2026-07-01", "2026-07-31", 2)],
    months: [{ month: "2026-07", close_id: "apc_1", revision: 1, input_hash: "abc" }],
  };
  it("is stable for the same plan", () => {
    expect(chainHash(plan)).toBe(chainHash({ ...plan }));
    expect(chainHash(plan)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("changes when a statement revision moves (someone touched the chain)", () => {
    const moved = {
      ...plan,
      statements: [{ ...plan.statements[0]!, revision: 4 }, plan.statements[1]!],
    };
    expect(chainHash(moved)).not.toBe(chainHash(plan));
  });
  it("changes when a Month Close preview changes", () => {
    const moved = { ...plan, months: [{ ...plan.months[0]!, input_hash: "xyz" }] };
    expect(chainHash(moved)).not.toBe(chainHash(plan));
  });
  it("changes when a month joins or leaves the chain", () => {
    expect(chainHash({ ...plan, months: [] })).not.toBe(chainHash(plan));
  });
});
