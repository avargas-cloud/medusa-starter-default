import {
  computeBatchDay,
  etDateString,
  isValidBatchDay,
  parseCutoff,
} from "../../lib/finance/batch-day";

const CUTOFF = { h: 18, m: 45 };

describe("computeBatchDay", () => {
  // 18:44 ET on Jul 8 2026 (EDT, UTC-4) = 22:44 UTC
  it("keeps a payment before the cutoff on the same ET day", () => {
    expect(computeBatchDay("2026-07-08T22:44:00Z", CUTOFF)).toBe("2026-07-08");
  });

  it("keeps a payment at exactly the cutoff (18:45:00) on the same day", () => {
    expect(computeBatchDay("2026-07-08T22:45:00Z", CUTOFF)).toBe("2026-07-08");
  });

  it("rolls a payment seconds after the cutoff (18:45:30) to the next day", () => {
    expect(computeBatchDay("2026-07-08T22:45:30Z", CUTOFF)).toBe("2026-07-09");
  });

  it("rolls an evening payment to the next day (real case: payment 3062)", () => {
    // Jul 8 2026 8:51 PM ET = Jul 9 00:51 UTC
    expect(computeBatchDay("2026-07-09T00:51:51Z", CUTOFF)).toBe("2026-07-09");
  });

  it("keeps a post-midnight-UTC but pre-cutoff-ET payment on the ET day", () => {
    // Jul 8 2026 3:13 PM ET = 19:13 UTC — same day even though UTC date differs later
    expect(computeBatchDay("2026-07-08T19:13:13Z", CUTOFF)).toBe("2026-07-08");
  });

  it("handles month rollover (Jul 31 8 PM ET → Aug 1)", () => {
    expect(computeBatchDay("2026-08-01T00:00:00Z", CUTOFF)).toBe("2026-08-01"); // Jul 31 8 PM ET
  });

  it("handles year rollover (Dec 31 8 PM ET → Jan 1)", () => {
    // Dec 31 2026 8 PM ET (EST, UTC-5) = Jan 1 2027 01:00 UTC
    expect(computeBatchDay("2027-01-01T01:00:00Z", CUTOFF)).toBe("2027-01-01");
  });

  it("is DST-safe on the spring-forward day (Mar 8 2026)", () => {
    // Mar 8 2026 7:00 PM EDT = 23:00 UTC — after cutoff → Mar 9
    expect(computeBatchDay("2026-03-08T23:00:00Z", CUTOFF)).toBe("2026-03-09");
    // Mar 8 2026 1:30 AM EST = 06:30 UTC — before cutoff → Mar 8
    expect(computeBatchDay("2026-03-08T06:30:00Z", CUTOFF)).toBe("2026-03-08");
  });

  it("is DST-safe on the fall-back day (Nov 1 2026)", () => {
    // Nov 1 2026 7:00 PM EST = Nov 2 00:00 UTC — after cutoff → Nov 2
    expect(computeBatchDay("2026-11-02T00:00:00Z", CUTOFF)).toBe("2026-11-02");
    // Nov 1 2026 1:30 AM (second occurrence, EST) = 06:30 UTC — before cutoff → Nov 1
    expect(computeBatchDay("2026-11-01T06:30:00Z", CUTOFF)).toBe("2026-11-01");
  });

  it("supports a custom cutoff", () => {
    // 2:01 PM ET with a 14:00 cutoff → next day
    expect(
      computeBatchDay("2026-07-08T18:01:00Z", { h: 14, m: 0 })
    ).toBe("2026-07-09");
  });
});

describe("etDateString", () => {
  it("returns the plain ET date with no cutoff rule (backfill semantics)", () => {
    // Jul 8 2026 11:59 PM ET = Jul 9 03:59 UTC — stays Jul 8
    expect(etDateString("2026-07-09T03:59:00Z")).toBe("2026-07-08");
  });
});

describe("parseCutoff", () => {
  it("parses valid HH:MM", () => {
    expect(parseCutoff("18:45")).toEqual({ h: 18, m: 45 });
    expect(parseCutoff("6:45")).toEqual({ h: 6, m: 45 });
    expect(parseCutoff("00:00")).toEqual({ h: 0, m: 0 });
  });

  it("rejects malformed values", () => {
    expect(parseCutoff("24:00")).toBeNull();
    expect(parseCutoff("18:60")).toBeNull();
    expect(parseCutoff("6:45pm")).toBeNull();
    expect(parseCutoff("")).toBeNull();
    expect(parseCutoff(null)).toBeNull();
    expect(parseCutoff(undefined)).toBeNull();
  });
});

describe("isValidBatchDay", () => {
  it("accepts real zero-padded dates", () => {
    expect(isValidBatchDay("2026-07-09")).toBe(true);
    expect(isValidBatchDay("2026-02-28")).toBe(true);
  });

  it("rejects impossible or unpadded dates", () => {
    expect(isValidBatchDay("2026-99-99")).toBe(false);
    expect(isValidBatchDay("2026-02-30")).toBe(false);
    expect(isValidBatchDay("2026-7-9")).toBe(false);
    expect(isValidBatchDay("not-a-date")).toBe(false);
  });
});
