import { collectionAllowanceCents, fixedDirectionFor, remittance, signedAdjustment, splitStateSurtax } from "../remittance";

describe("sales tax remittance math", () => {
  it("collection allowance: 2.5% of the first $1,200, max $30, only when timely", () => {
    expect(collectionAllowanceCents(736378n, true)).toBe(3000n); // $7,363.78 → $30
    expect(collectionAllowanceCents(100000n, true)).toBe(2500n); // $1,000 → $25
    expect(collectionAllowanceCents(120000n, true)).toBe(3000n); // exactly $1,200 → $30
    expect(collectionAllowanceCents(736378n, false)).toBe(0n);
    expect(collectionAllowanceCents(0n, true)).toBe(0n);
    expect(collectionAllowanceCents(-500n, true)).toBe(0n);
  });

  it("state / surtax split of a flat 7% item: surtax = 1/7 of the tax, rounded to the cent", () => {
    const split = splitStateSurtax(736378n, 600, 100);
    expect(split.surtax_cents).toBe(105197n); // 7363.78 / 7 = 1051.968…
    expect(split.state_cents + split.surtax_cents).toBe(736378n);
    expect(splitStateSurtax(-700n, 600, 100)).toEqual({ state_cents: -600n, surtax_cents: -100n });
    expect(splitStateSurtax(1000n, 0, 0)).toEqual({ state_cents: 1000n, surtax_cents: 0n });
  });

  it("directions are fixed by type except rounding/other", () => {
    expect(fixedDirectionFor("collection_allowance")).toBe("decrease");
    expect(fixedDirectionFor("prior_credit")).toBe("decrease");
    expect(fixedDirectionFor("penalty")).toBe("increase");
    expect(fixedDirectionFor("interest")).toBe("increase");
    expect(fixedDirectionFor("rounding")).toBeNull();
    expect(fixedDirectionFor("other")).toBeNull();
    expect(signedAdjustment("decrease", 3000n)).toBe(-3000n);
    expect(signedAdjustment("increase", 3000n)).toBe(3000n);
  });

  it("remittance = tax due + penalty + interest − allowance − prior credit ± other (January 2026 shape: 6,292.38 − 30 = 6,262.38)", () => {
    const r = remittance({
      tax_due_cents: 629238n,
      adjustments: [{ type: "collection_allowance", signed_cents: -3000n }],
    });
    expect(r.allowance_cents).toBe(3000n);
    expect(r.remittance_cents).toBe(626238n);
    const late = remittance({
      tax_due_cents: 629238n,
      adjustments: [
        { type: "penalty", signed_cents: 5000n },
        { type: "interest", signed_cents: 123n },
        { type: "prior_credit", signed_cents: -1000n },
        { type: "rounding", signed_cents: -1n },
      ],
    });
    expect(late.penalty_cents).toBe(5000n);
    expect(late.interest_cents).toBe(123n);
    expect(late.prior_credit_cents).toBe(1000n);
    expect(late.other_cents).toBe(-1n);
    expect(late.remittance_cents).toBe(629238n + 5000n + 123n - 1000n - 1n);
  });
});
