/**
 * Unit tests for the customer tier predicate (pure logic).
 *
 * Filename ends in `.unit.spec.ts` (not `.spec.ts`) because
 * `jest.config.js`'s `TEST_TYPE=unit` testMatch is
 * `**\/src/**\/__tests__/**\/*.unit.spec.[jt]s` — a plain `.spec.ts` here
 * would never be collected.
 */
import {
  resolveCustomerTier,
  isWholesaleTier,
  type CustomerTierInput,
} from "../customer-tier";
import matrix from "../../../../docs/fixtures/customer-tier-matrix.json";

type MatrixCase = {
  name: string;
  input: CustomerTierInput | null;
  expected: "wholesale" | "retail";
};

describe("resolveCustomerTier — group is the truth, metadata is transitional", () => {
  for (const testCase of matrix as MatrixCase[]) {
    it(`${testCase.name} → ${testCase.expected}`, () => {
      expect(resolveCustomerTier(testCase.input)).toBe(testCase.expected);
    });
  }

  it("isWholesaleTier mirrors resolveCustomerTier === 'wholesale'", () => {
    expect(isWholesaleTier({ groups: [{ name: "Wholesale" }] })).toBe(true);
    expect(isWholesaleTier({ groups: [{ name: "Retail" }] })).toBe(false);
    expect(isWholesaleTier(null)).toBe(false);
  });

  it("group check wins even when metadata disagrees", () => {
    expect(
      resolveCustomerTier({
        groups: [{ name: "Wholesale" }],
        metadata: { price_level: "Retail" },
      })
    ).toBe("wholesale");
  });

  it("undefined groups + undefined metadata → retail", () => {
    expect(resolveCustomerTier(undefined)).toBe("retail");
  });
});
