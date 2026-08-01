import {
  normalizeTermsKey,
  parseQbTermsMap,
  QB_TERMS_QUERY_QBXML,
} from "../../../lib/quickbooks/qb-terms";

/** Shape a completed bridge poll returns. */
const polled = (termsQueryRs: Record<string, unknown>) => ({
  operation: {
    status: "completed",
    result: { QBXML: { QBXMLMsgsRs: { TermsQueryRs: termsQueryRs } } },
  },
});

describe("qb-terms", () => {
  describe("QB_TERMS_QUERY_QBXML", () => {
    it("carries the full envelope — the raw bridge passthrough adds none", () => {
      expect(QB_TERMS_QUERY_QBXML).toContain("<?qbxml version=");
      expect(QB_TERMS_QUERY_QBXML).toContain("<QBXMLMsgsRq");
      expect(QB_TERMS_QUERY_QBXML).toContain("</QBXML>");
    });

    it("asks for inactive terms too (live vendors still reference them)", () => {
      expect(QB_TERMS_QUERY_QBXML).toContain("<ActiveStatus>All</ActiveStatus>");
    });
  });

  describe("normalizeTermsKey", () => {
    it("ignores case and surrounding/inner whitespace", () => {
      expect(normalizeTermsKey("  Net-30 ")).toBe("net-30");
      expect(normalizeTermsKey("Due  on   receipt")).toBe("due on receipt");
    });

    it("keeps punctuation — 'Net 30' and 'Net-30' are distinct QB terms", () => {
      expect(normalizeTermsKey("Net 30")).not.toBe(normalizeTermsKey("Net-30"));
    });
  });

  describe("parseQbTermsMap", () => {
    it("maps standard terms to their QB due days", () => {
      const map = parseQbTermsMap(
        polled({
          StandardTermsRet: [
            { Name: "Net-30", StdDueDays: "30", IsActive: "true" },
            { Name: "Due on receipt", StdDueDays: "0", IsActive: "true" },
            { Name: "Consignment", StdDueDays: "90", IsActive: "false" },
          ],
        })
      );

      expect(map["net-30"].days).toBe(30);
      expect(map["due on receipt"].days).toBe(0);
      expect(map["consignment"]).toEqual({
        name: "Consignment",
        days: 90,
        day_of_month_due: null,
        due_next_month_days: null,
        is_active: false,
      });
    });

    it("handles a single term returned as a bare object, not an array", () => {
      const map = parseQbTermsMap(
        polled({ StandardTermsRet: { Name: "Net-15", StdDueDays: "15" } })
      );
      expect(map["net-15"].days).toBe(15);
    });

    it("leaves date-driven terms without a day count", () => {
      const map = parseQbTermsMap(
        polled({
          DateDrivenTermsRet: [
            { Name: "120", DayOfMonthDue: "20", IsActive: "false" },
          ],
        })
      );
      expect(map["120"]).toMatchObject({ days: null, day_of_month_due: 20 });
    });

    it("carries DueNextMonthDays, which decides whether a bill rolls a month", () => {
      const map = parseQbTermsMap(
        polled({
          DateDrivenTermsRet: [
            { Name: "120", DayOfMonthDue: "20", DueNextMonthDays: "10" },
          ],
        })
      );
      expect(map["120"].due_next_month_days).toBe(10);
    });

    it("never puts a due-next-month window on a standard term", () => {
      const map = parseQbTermsMap(
        polled({
          StandardTermsRet: [
            { Name: "Net-30", StdDueDays: "30", DueNextMonthDays: "10" },
          ],
        })
      );
      expect(map["net-30"].due_next_month_days).toBeNull();
    });

    it("returns an empty map instead of throwing on an unexpected payload", () => {
      expect(parseQbTermsMap(undefined)).toEqual({});
      expect(parseQbTermsMap({ operation: { status: "failed" } })).toEqual({});
    });

    it("skips entries with no name rather than keying on undefined", () => {
      const map = parseQbTermsMap(
        polled({ StandardTermsRet: [{ StdDueDays: "30" }] })
      );
      expect(Object.keys(map)).toHaveLength(0);
    });
  });
});
