/**
 * QuickBooks Desktop caps `<RefNumber>` at 11 characters and rejects the whole
 * request past it (error 3070) — the document is never created.
 *
 * The packing-slip field feeding it is free text, so "Correct Quantity
 * Received" (25 chars) stopped RCP-1166 from reaching QuickBooks at all, and
 * the failure showed up as a red pipeline row far from the screen where the
 * text was typed.
 */
import {
  QB_REF_NUMBER_MAX_LENGTH,
  refNumberWouldTruncate,
  toQbRefNumber,
} from "../../lib/quickbooks/qb-ref-number";

describe("toQbRefNumber", () => {
  it("cuts at QuickBooks' 11-character limit", () => {
    // The exact string that failed in production.
    const out = toQbRefNumber("Correct Quantity Received");
    expect(out).toBe("Correct Qua");
    expect(out).toHaveLength(QB_REF_NUMBER_MAX_LENGTH);
  });

  it("leaves a normal vendor reference untouched", () => {
    // Real references are short and prefixed; the common case must not change.
    expect(toQbRefNumber("V260717-I1")).toBe("V260717-I1");
    expect(toQbRefNumber("PS-0042")).toBe("PS-0042");
  });

  it("keeps a value that is exactly at the limit", () => {
    expect(toQbRefNumber("12345678901")).toBe("12345678901");
  });

  it("returns null for nothing to send", () => {
    // Null, not "" — the builder omits the element entirely, and an empty
    // RefNumber is not the same as no RefNumber.
    expect(toQbRefNumber(null)).toBeNull();
    expect(toQbRefNumber(undefined)).toBeNull();
    expect(toQbRefNumber("")).toBeNull();
    expect(toQbRefNumber("   ")).toBeNull();
  });

  it("trims before measuring, so padding never costs real characters", () => {
    expect(toQbRefNumber("  V260717-I1  ")).toBe("V260717-I1");
  });

  it("reports whether characters would be lost", () => {
    // Lets a caller warn instead of silently shortening a vendor's reference.
    expect(refNumberWouldTruncate("Correct Quantity Received")).toBe(true);
    expect(refNumberWouldTruncate("V260717-I1")).toBe(false);
    expect(refNumberWouldTruncate("12345678901")).toBe(false);
    expect(refNumberWouldTruncate(null)).toBe(false);
  });
});
