import { getDbPool } from "../../api/utils/db-pool";
import { assertMatchSourceHash } from "../../lib/banking/review-matching";
import { matchSuggestions, matchSuggestionsQuery, summarizeMatchSuggestion } from "../../lib/banking/review-match-suggestions";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));
jest.mock("../../lib/banking/security", () => ({
  ...jest.requireActual("../../lib/banking/security"),
  bankingConfig: () => ({ enabled: true, environment: "sandbox" }),
  requireBankingSandbox: jest.fn(),
}));

const sourceHash = "a".repeat(32);
const best = { id: "cpay_1", display_id: 42, customer_id: "cus_1", customer_name: "Customer One",
  date: "2026-09-02", reference: "0042", source_hash: sourceHash };

describe("bank match suggestions", () => {
  it("accepts exactly one bounded selector and real calendar dates", () => {
    expect(matchSuggestionsQuery.parse({ ids: "t1,t2" })).toEqual({ ids: ["t1", "t2"] });
    expect(matchSuggestionsQuery.parse({ date: "2026-09-02" })).toEqual({ date: "2026-09-02" });
    for (const value of [{}, { ids: "t1", date: "2026-09-02" }, { ids: "t1,t1" }, { ids: "" },
      { ids: "t1/secret" }, { date: "2026-02-30" }, { date: "2026-09-02", unknown: "field" },
      { ids: Array.from({ length: 101 }, (_, index) => `t${index}`).join(",") }]) {
      expect(matchSuggestionsQuery.safeParse(value).success).toBe(false);
    }
    expect(matchSuggestionsQuery.safeParse({ ids: Array.from({ length: 100 }, (_, i) => `t${i}`).join(",") }).success).toBe(true);
  });

  it("keeps an absent match explicit", () => {
    expect(summarizeMatchSuggestion({ transaction_id: "t1", candidate_count: "0", best: null,
      reference_match: null, date_distance: null })).toEqual({ transaction_id: "t1", candidate_count: 0,
      best: null, ambiguous: false, reason: "No individual receipt matches this amount and currency." });
  });

  it("does not hide ambiguity behind a strong first reference match", () => {
    const result = summarizeMatchSuggestion({ transaction_id: "t1", candidate_count: "3", best,
      reference_match: true, date_distance: 2 });
    expect(result.ambiguous).toBe(true);
    expect(result.candidate_count).toBe(3);
    expect(result.reason).toContain("Multiple receipts");
    expect(result.reason).toContain("reference matches");
    expect(result.reason).toContain("2 day(s)");
  });

  it("keeps old exact-amount checks visible without claiming their date matches", () => {
    const result = summarizeMatchSuggestion({ transaction_id: "t1", candidate_count: "1", best,
      reference_match: false, date_distance: 45 });
    expect(result.best?.id).toBe("cpay_1");
    expect(result.reason).toContain("45 day(s)");
    expect(result.reason).not.toContain("reference matches");
  });

  it("batches individual and grouped suggestions without querying per movement", async () => {
    const deposit = { id: "d1", reference: "Deposit one", date: "2026-09-02", net_amount: "10.00", source_hash: sourceHash };
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ transaction_id: "t1", candidate_count: "1",
      best, reference_match: true, date_distance: 0 }] }).mockResolvedValueOnce({ rows: [
        { transaction_id: "t1", deposit_count: 1, best_deposit: deposit }] });
    jest.mocked(getDbPool).mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
    const result = await matchSuggestions({ ids: ["t1", "t2"] });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual([["t1", "t2"], null]);
    expect(query.mock.calls[1]?.[1]).toEqual([["t1"]]);
    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(result.suggestions[0]?.best?.customer_id).toBe("cus_1");
    expect(result.suggestions[0]?.best_deposit).toEqual(deposit);
    expect(result.suggestions[0]?.deposit_count).toBe(1);
    expect(Object.keys(result)).toEqual(["suggestions"]);
  });

  it("runs one query for a whole day and rejects invalid selectors before DB access", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    jest.mocked(getDbPool).mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
    expect(await matchSuggestions({ date: "2026-09-02" })).toEqual({ suggestions: [] });
    expect(query.mock.calls[0]?.[1]).toEqual([null, "2026-09-02"]);
    await expect(matchSuggestions({ ids: [] })).rejects.toMatchObject({ code: "BANKING_INVALID_REQUEST" });
    await expect(matchSuggestions({ ids: ["t1"], date: "2026-09-02" })).rejects.toMatchObject({ code: "BANKING_INVALID_REQUEST" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires the selected receipt version and rejects a changed source", () => {
    for (const absent of [undefined, null, "", "bad"]) {
      expect(() => assertMatchSourceHash(absent, sourceHash)).toThrow("BANKING_MATCH_SOURCE_HASH_REQUIRED");
    }
    expect(() => assertMatchSourceHash("b".repeat(32), sourceHash)).toThrow("BANKING_MATCH_STALE");
    expect(() => assertMatchSourceHash(sourceHash, sourceHash)).not.toThrow();
  });
});
