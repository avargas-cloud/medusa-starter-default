import { pgDateToIso } from "../et";

describe("pgDateToIso", () => {
  it("converts a pg `date` Date (local-midnight) using LOCAL getters, not toISOString", () => {
    // node-postgres parses a `date` column as `new Date(year, monthIndex, day)`
    // — local midnight. `toISOString()` would convert to UTC first and could
    // roll the date backward a day on a UTC-negative host; the local getters
    // recover the exact calendar date that was stored.
    const value = new Date(2026, 8, 11); // September 11, 2026, local midnight
    expect(pgDateToIso(value)).toBe("2026-09-11");
  });

  it("pads single-digit month/day", () => {
    expect(pgDateToIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("passes an already-ISO string through unchanged", () => {
    expect(pgDateToIso("2026-09-11")).toBe("2026-09-11");
  });

  it("truncates a string with a time component to the date part", () => {
    expect(pgDateToIso("2026-09-11T00:00:00.000Z")).toBe("2026-09-11");
  });
});
