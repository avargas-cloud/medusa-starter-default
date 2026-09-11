import { absBigInt, centsFromNumeric, costCentsHalfUp, sanitizeRole, signedLine } from "../money";
import { account } from "./fixtures";

describe("centsFromNumeric", () => {
  it("parses an integer-looking numeric string as-is (the column is already cents)", () => {
    expect(centsFromNumeric("12345")).toBe(12345n);
  });
  it("parses a numeric with a trailing .00 as the same whole cents", () => {
    expect(centsFromNumeric("123.00")).toBe(123n);
  });
  it("rounds half-up on a spurious fractional remainder", () => {
    expect(centsFromNumeric("1.5")).toBe(2n);
    expect(centsFromNumeric("1.4")).toBe(1n);
  });
  it("handles negative amounts", () => {
    expect(centsFromNumeric("-45.00")).toBe(-45n);
  });
  it("treats null/undefined as zero", () => {
    expect(centsFromNumeric(null)).toBe(0n);
    expect(centsFromNumeric(undefined)).toBe(0n);
  });
  it("accepts a JS number too", () => {
    expect(centsFromNumeric(500)).toBe(500n);
  });
});

describe("costCentsHalfUp", () => {
  it("multiplies dollars × quantity and rounds to the nearest cent", () => {
    expect(costCentsHalfUp("2.50", 4)).toBe(1000n); // exact: 10.00
    expect(costCentsHalfUp("1.996", 1)).toBe(200n); // 199.6¢ → 200¢
  });
  it("scales by quantity before rounding", () => {
    expect(costCentsHalfUp("3.333", 3)).toBe(1000n); // 9.999 → 1000
  });
  it("returns 0 for a null/zero/negative cost", () => {
    expect(costCentsHalfUp(null, 5)).toBe(0n);
    expect(costCentsHalfUp("0", 5)).toBe(0n);
    expect(costCentsHalfUp("-1", 5)).toBe(0n);
  });
  it("returns 0 for a non-positive quantity", () => {
    expect(costCentsHalfUp("10", 0)).toBe(0n);
  });
});

describe("absBigInt", () => {
  it("returns the magnitude regardless of sign", () => {
    expect(absBigInt(-5n)).toBe(5n);
    expect(absBigInt(5n)).toBe(5n);
    expect(absBigInt(0n)).toBe(0n);
  });
});

describe("signedLine", () => {
  const acct = account("A-1", "Expense", "debit");
  it("debits on positive, credits on negative, omits on zero", () => {
    expect(signedLine("role", acct, 5n)).toEqual({ role: "role", account: acct, debit_cents: 5n, credit_cents: 0n });
    expect(signedLine("role", acct, -5n)).toEqual({ role: "role", account: acct, debit_cents: 0n, credit_cents: 5n });
    expect(signedLine("role", acct, 0n)).toBeNull();
  });
});

describe("sanitizeRole", () => {
  it("lowercases and replaces illegal chars — matches bank_journal_line's CHECK ^[a-z][a-z0-9_]{0,79}$", () => {
    const role = sanitizeRole("qb_account", "8000018A-1786738459");
    expect(role).toMatch(/^[a-z][a-z0-9_]{0,79}$/);
    expect(role).toBe("qb_account_8000018a_1786738459");
  });
  it("two different real QB ListIDs never collide", () => {
    const a = sanitizeRole("qb_account", "8000018A-1786738459");
    const b = sanitizeRole("qb_account", "8000018B-1786738459");
    expect(a).not.toBe(b);
  });
});
