/**
 * Unit tests for lib/date/et.ts — getBusinessDateString (moved verbatim from
 * lib/quickbooks/order-flow-core.ts) and etMidnightUtc.
 *
 * getBusinessDateString guards against two real production incidents:
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

import { getBusinessDateString, etMidnightUtc } from "../../../lib/date/et";

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

describe("etMidnightUtc", () => {
  it("resolves EDT midnight (UTC-4) for a summer date", () => {
    // 2026-08-01 America/New_York is EDT → midnight ET = 04:00Z.
    const d = etMidnightUtc(2026, 7, 1); // monthIndex 7 = August
    expect(d.toISOString()).toBe("2026-08-01T04:00:00.000Z");
  });

  it("resolves EST midnight (UTC-5) for a winter date", () => {
    // 2026-01-01 America/New_York is EST → midnight ET = 05:00Z.
    const d = etMidnightUtc(2026, 0, 1); // monthIndex 0 = January
    expect(d.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("handles the spring-forward DST boundary (2026-03-08)", () => {
    // DST starts 2026-03-08 2am → still EST (UTC-5) at midnight that day.
    const d = etMidnightUtc(2026, 2, 8);
    expect(d.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("handles the fall-back DST boundary (2026-11-01)", () => {
    // DST ends 2026-11-01 2am → still EDT (UTC-4) at midnight that day.
    const d = etMidnightUtc(2026, 10, 1);
    expect(d.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});
