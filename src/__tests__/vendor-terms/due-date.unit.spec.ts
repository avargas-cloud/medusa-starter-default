import {
  addDays,
  addMonths,
  dayOfMonthIn,
  daysBetween,
  daysInMonth,
  formatYmd,
  parseYmd,
  resolveDueDate,
} from "../../lib/vendor-terms/due-date";
import { isValidTerm, normalizeVendorTermKey } from "../../lib/vendor-terms/types";

describe("vendor-terms/due-date", () => {
  describe("standard terms (bill date + N days)", () => {
    it("adds the day count", () => {
      expect(resolveDueDate("2026-07-31", { days: 30, day_of_month_due: null }))
        .toBe("2026-08-30");
    });

    it("Due on Receipt (0 days) is the bill date itself", () => {
      expect(resolveDueDate("2026-07-31", { days: 0, day_of_month_due: null }))
        .toBe("2026-07-31");
    });

    it("crosses a year boundary", () => {
      expect(resolveDueDate("2026-12-20", { days: 30, day_of_month_due: null }))
        .toBe("2027-01-19");
    });

    it("handles a leap February", () => {
      expect(resolveDueDate("2028-02-28", { days: 1, day_of_month_due: null }))
        .toBe("2028-02-29");
    });

    it("Consignment (90) and 1 Year (360) are just longer counts", () => {
      expect(resolveDueDate("2026-01-01", { days: 90, day_of_month_due: null }))
        .toBe("2026-04-01");
      expect(resolveDueDate("2026-01-01", { days: 360, day_of_month_due: null }))
        .toBe("2026-12-27");
    });
  });

  describe("date-driven terms (due day D of the month)", () => {
    // The two live in production: "120" → due the 20th, "10 Month" → the 28th.
    it("uses this month when the due day is still ahead", () => {
      expect(
        resolveDueDate("2026-07-05", { days: null, day_of_month_due: 20 })
      ).toBe("2026-07-20");
    });

    it("rolls to next month when the due day already passed", () => {
      expect(
        resolveDueDate("2026-07-25", { days: null, day_of_month_due: 20 })
      ).toBe("2026-08-20");
    });

    it("rolls when the bill lands on the due day itself only if grace demands it", () => {
      expect(
        resolveDueDate("2026-07-20", { days: null, day_of_month_due: 20 })
      ).toBe("2026-07-20");
      expect(
        resolveDueDate("2026-07-20", {
          days: null,
          day_of_month_due: 20,
          due_next_month_days: 1,
        })
      ).toBe("2026-08-20");
    });

    it("honours QB's due-next-month grace window", () => {
      // Dated the 19th, due the 20th, but QB insists on 10 days of runway.
      expect(
        resolveDueDate("2026-07-19", {
          days: null,
          day_of_month_due: 20,
          due_next_month_days: 10,
        })
      ).toBe("2026-08-20");
      // Same term, dated early enough to make this month's due day.
      expect(
        resolveDueDate("2026-07-05", {
          days: null,
          day_of_month_due: 20,
          due_next_month_days: 10,
        })
      ).toBe("2026-07-20");
    });

    it("clamps a 31st due day to the last real day of a short month", () => {
      expect(
        resolveDueDate("2026-02-01", { days: null, day_of_month_due: 31 })
      ).toBe("2026-02-28");
      expect(
        resolveDueDate("2028-02-01", { days: null, day_of_month_due: 31 })
      ).toBe("2028-02-29");
    });

    it("rolls across a year boundary", () => {
      expect(
        resolveDueDate("2026-12-25", { days: null, day_of_month_due: 20 })
      ).toBe("2027-01-20");
    });

    it("rolls from January 31 into a clamped February", () => {
      expect(
        resolveDueDate("2026-01-31", {
          days: null,
          day_of_month_due: 30,
          due_next_month_days: 5,
        })
      ).toBe("2026-02-28");
    });
  });

  describe("unresolvable input returns null, never day zero", () => {
    it.each([
      ["both halves null", { days: null, day_of_month_due: null }],
      ["negative days", { days: -1, day_of_month_due: null }],
      ["non-integer days", { days: 1.5, day_of_month_due: null }],
      ["day of month 0", { days: null, day_of_month_due: 0 }],
      ["day of month 32", { days: null, day_of_month_due: 32 }],
    ])("%s", (_label, term) => {
      expect(resolveDueDate("2026-07-31", term)).toBeNull();
    });

    it.each(["", "2026-7-31", "31/07/2026", "2026-13-01", "2026-02-30", "not a date"])(
      "rejects the bill date %p",
      (bad) => {
        expect(resolveDueDate(bad, { days: 30, day_of_month_due: null })).toBeNull();
      }
    );
  });

  describe("no timezone drift", () => {
    // new Date("2026-07-31") is UTC midnight; rendered in any negative offset
    // it prints as the 30th. The whole module avoids that path — prove it.
    it("round-trips every day of a month regardless of host zone", () => {
      for (let d = 1; d <= 31; d++) {
        const iso = `2026-07-${String(d).padStart(2, "0")}`;
        expect(resolveDueDate(iso, { days: 0, day_of_month_due: null })).toBe(iso);
      }
    });
  });

  describe("calendar helpers", () => {
    it("daysInMonth knows leap years", () => {
      expect(daysInMonth(2026, 2)).toBe(28);
      expect(daysInMonth(2028, 2)).toBe(29);
      expect(daysInMonth(2000, 2)).toBe(29);
      expect(daysInMonth(1900, 2)).toBe(28);
      expect(daysInMonth(2026, 12)).toBe(31);
    });

    it("addMonths clamps the day", () => {
      expect(formatYmd(addMonths({ y: 2026, m: 1, d: 31 }, 1))).toBe("2026-02-28");
      expect(formatYmd(addMonths({ y: 2026, m: 12, d: 15 }, 1))).toBe("2027-01-15");
    });

    it("addDays and daysBetween are inverses", () => {
      const base = parseYmd("2026-07-31")!;
      expect(daysBetween(base, addDays(base, 45))).toBe(45);
      expect(daysBetween(base, addDays(base, -45))).toBe(-45);
    });

    it("dayOfMonthIn clamps", () => {
      expect(formatYmd(dayOfMonthIn(2026, 2, 31))).toBe("2026-02-28");
      expect(formatYmd(dayOfMonthIn(2026, 3, 31))).toBe("2026-03-31");
    });
  });
});

describe("vendor-terms/types", () => {
  it("accepts exactly one rule and rejects both or neither", () => {
    expect(isValidTerm({ days: 30, day_of_month_due: null })).toBe(true);
    expect(isValidTerm({ days: 0, day_of_month_due: null })).toBe(true);
    expect(isValidTerm({ days: null, day_of_month_due: 20 })).toBe(true);
    expect(isValidTerm({ days: null, day_of_month_due: null })).toBe(false);
    expect(isValidTerm({ days: 30, day_of_month_due: 20 })).toBe(false);
    expect(isValidTerm({ days: 400, day_of_month_due: null })).toBe(false);
    expect(isValidTerm({ days: null, day_of_month_due: 99 })).toBe(false);
  });

  it("normalizes case and whitespace but NOT punctuation", () => {
    expect(normalizeVendorTermKey("  NET-30 ")).toBe("net-30");
    expect(normalizeVendorTermKey("Net  30")).toBe("net 30");
    // Net 30 and Net-30 are two distinct live terms in the company file.
    expect(normalizeVendorTermKey("Net 30")).not.toBe(
      normalizeVendorTermKey("Net-30")
    );
  });
});
