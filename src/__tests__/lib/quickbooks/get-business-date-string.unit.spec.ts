/**
 * Unit tests for getBusinessDateString — the QB <TxnDate> source-of-truth
 * helper. Guards against two real production incidents:
 *
 * 1. Retry-next-day bug: when a QB bridge call fails day-0 and succeeds
 *    day-1, the document used to book with day-1's date. The fix passes the
 *    original document's created_at; this test proves the helper preserves
 *    that date verbatim regardless of when the call is made.
 *
 * 2. UTC midnight crossover bug: a Florida 11pm sale was being booked as
 *    the next calendar day because toISOString() converts to UTC. The helper
 *    formats in America/New_York (default) so the calendar date matches the
 *    store's local day.
 */

import { getBusinessDateString } from "../../../lib/quickbooks/order-flow-core";

describe("getBusinessDateString", () => {
  it("returns the calendar date in America/New_York, not UTC", () => {
    // 2026-05-26 23:30:00 EDT (UTC-4) = 2026-05-27T03:30:00Z
    // toISOString().split('T')[0] would give "2026-05-27" — wrong.
    const florida1130pm = "2026-05-27T03:30:00.000Z";
    expect(getBusinessDateString(florida1130pm)).toBe("2026-05-26");
  });

  it("returns the same date for a daytime instant", () => {
    // 2026-05-27 14:00:00 EDT = 2026-05-27T18:00:00Z
    const florida2pm = "2026-05-27T18:00:00.000Z";
    expect(getBusinessDateString(florida2pm)).toBe("2026-05-27");
  });

  it("is stable across multiple calls with the same source date", () => {
    // Models the retry-next-day scenario: same source date, hours apart.
    const sourceDate = "2026-05-26T22:00:00.000Z"; // Monday 6pm EDT
    const callA = getBusinessDateString(sourceDate);
    const callB = getBusinessDateString(sourceDate);
    expect(callA).toBe(callB);
    expect(callA).toBe("2026-05-26");
  });

  it("accepts a Date instance", () => {
    const d = new Date("2026-05-27T18:00:00.000Z");
    expect(getBusinessDateString(d)).toBe("2026-05-27");
  });

  it("treats null and undefined as 'today' (only safe at boundaries)", () => {
    const a = getBusinessDateString(null);
    const b = getBusinessDateString(undefined);
    const today = getBusinessDateString(new Date());
    expect(a).toBe(today);
    expect(b).toBe(today);
  });

  it("returns YYYY-MM-DD format (no time component)", () => {
    const result = getBusinessDateString("2026-05-27T18:00:00.000Z");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
