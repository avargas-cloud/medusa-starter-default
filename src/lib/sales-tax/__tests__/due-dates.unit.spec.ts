import {
  filingDueDates,
  filingUrgency,
  holidaysFor,
  isBusinessDay,
  periodBounds,
  periodOfPaymentDay,
  weekday,
} from "../due-dates";

/**
 * sales-tax-center-20260917 — vencimientos del DR-15 (Florida). Los casos
 * fijos son fechas REALES del calendario 2026, no fixtures inventados.
 */
describe("sales tax due dates", () => {
  it("weekday: 2026-09-20 is a Sunday, 2026-09-18 a Friday", () => {
    expect(weekday("2026-09-20")).toBe(0);
    expect(weekday("2026-09-18")).toBe(5);
    expect(weekday("1970-01-01")).toBe(4);
  });

  it("holidays 2026: Labor Day 09/07, Thanksgiving 11/26 + 11/27, Christmas 12/25, July 4 observed on Friday 07/03", () => {
    const h = holidaysFor(2026);
    expect(h.has("2026-09-07")).toBe(true);
    expect(h.has("2026-11-26")).toBe(true);
    expect(h.has("2026-11-27")).toBe(true);
    expect(h.has("2026-12-25")).toBe(true);
    expect(h.has("2026-07-03")).toBe(true);
    expect(isBusinessDay("2026-07-03")).toBe(false);
    expect(isBusinessDay("2026-07-06")).toBe(true);
  });

  it("August 2026 return: the 20th is a Sunday → filing timely through Monday 09/21, e-pay initiated by Friday 09/18", () => {
    const due = filingDueDates("2026-08");
    expect(due).toEqual({
      period: "2026-08",
      opens_on: "2026-09-01",
      statutory_due: "2026-09-20",
      filing_due: "2026-09-21",
      epay_cutoff: "2026-09-18",
    });
  });

  it("December 2025 return: due 01/20/2026 (Tuesday), e-pay by Friday 01/16 — MLK Day 01/19 is not a business day", () => {
    const due = filingDueDates("2025-12");
    expect(due.filing_due).toBe("2026-01-20");
    expect(due.epay_cutoff).toBe("2026-01-16");
  });

  it("urgency from today's date", () => {
    const due = filingDueDates("2026-08");
    expect(filingUrgency(due, "2026-08-31")).toBe("not_open");
    expect(filingUrgency(due, "2026-09-05")).toBe("upcoming");
    expect(filingUrgency(due, "2026-09-17")).toBe("due_soon");
    expect(filingUrgency(due, "2026-09-22")).toBe("overdue");
  });

  it("period helpers", () => {
    expect(periodBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(periodOfPaymentDay("2026-01-16")).toBe("2025-12");
    expect(periodOfPaymentDay("2026-08-18")).toBe("2026-07");
  });
});
