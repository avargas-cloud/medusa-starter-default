import type { PoolClient } from "pg";

import { BankingError } from "../../lib/banking/security";
import { assertMatchable } from "../../lib/banking/statement-matching";
import { refreshSuggestionsForDocument } from "../../lib/banking/suggestion-refresh-document";
import type { StatementBookItem, StatementLine } from "../../lib/banking/statement-types";

// 09/18/2026: CHK-0999 was revised (#1127 → #1120). The ledger reversed the old
// entry and posted a new one, but the cached feed suggestion still pointed at
// the REVERSED line — and Confirm match accepted it: `matchStatement` never
// asked whether the book line was canceled. Two halves: the match refuses a
// canceled line (fail-closed), and a document change recomputes the
// suggestions of every draft statement its Bank lines touch.

function line(): StatementLine {
  return {
    id: "bsl_1",
    day: "2026-09-16",
    description: "CHECK 1120",
    amount_cents: -149467,
    source_hash: "lh1",
    transaction_id: "tx_1",
    blockers: [],
  } as unknown as StatementLine;
}
function book(overrides: Partial<StatementBookItem> = {}): StatementBookItem {
  return {
    kind: "journal_line",
    id: "bjl_old",
    day: "2026-09-16",
    reference: "CHK-0999 #1127",
    description: "Check CHK-0999",
    amount_cents: -149467,
    matched_cents: 0,
    remaining_cents: 149467,
    source_hash: "bh_old",
    transaction_id: null,
    blockers: [],
    ...overrides,
  };
}

describe("assertMatchable — a canceled book line is never matchable", () => {
  it("accepts a live line whose hash matches", () => {
    expect(() => assertMatchable(line(), book(), "bh_old")).not.toThrow();
  });
  it("rejects a reversed line even when the hash still matches (the stale suggestion case)", () => {
    expect(() => assertMatchable(line(), book({ canceled: true }), "bh_old")).toThrow(BankingError);
    try {
      assertMatchable(line(), book({ canceled: true }), "bh_old");
    } catch (error) {
      expect((error as BankingError).code).toBe("BANKING_STATEMENT_MATCH_CANCELED_ENTRY");
      expect((error as BankingError).status).toBe(409);
    }
  });
  it("still rejects drift and blockers", () => {
    expect(() => assertMatchable(line(), book(), "other")).toThrow("BANKING_STATEMENT_MATCH_SOURCE_DRIFT");
    expect(() => assertMatchable(line(), book({ blockers: ["X"] }), "bh_old")).toThrow("BANKING_STATEMENT_MATCH_SOURCE_DRIFT");
    expect(() => assertMatchable(undefined, book(), "bh_old")).toThrow("BANKING_STATEMENT_MATCH_SOURCE_DRIFT");
  });
});

describe("refreshSuggestionsForDocument", () => {
  it("finds every DRAFT statement whose window covers a Bank line of the document and refreshes each once", async () => {
    const query = jest.fn(async () => ({ rows: [{ id: "bst_a" }, { id: "bst_b" }] }));
    const refresh = jest.fn(async (id: string) => ({ statement_id: id, outcome: { status: "ok" } }));
    const result = await refreshSuggestionsForDocument(
      { query } as unknown as PoolClient,
      "gchk_1",
      "usr_1",
      refresh as never
    );
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql.replace(/\s+/g, " ")).toMatch(/s\.status='draft'/);
    expect(sql).toMatch(/e\.source_id=\$1/);
    expect(params).toEqual(["gchk_1"]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("bst_a", "usr_1", "manual");
    expect(result).toEqual(["bst_a", "bst_b"]);
  });
  it("never fails the document operation: a refresh error is swallowed and reported", async () => {
    const query = jest.fn(async () => ({ rows: [{ id: "bst_a" }] }));
    const refresh = jest.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      refreshSuggestionsForDocument({ query } as unknown as PoolClient, "gchk_1", "usr_1", refresh as never)
    ).resolves.toEqual([]);
  });
});
