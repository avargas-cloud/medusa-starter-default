import type { PoolClient } from "pg";
import { openingDifference, openingContext } from "../../lib/banking/opening-read";
import type { OpeningBalance } from "../../lib/banking/opening-types";

describe("verified opening equation uses bank book, statement and only old reconciling items", () => {
  const check = { kind: "outstanding_check", amount_cents: 100000 };
  const transit = { kind: "deposit_in_transit", amount_cents: 12000 };
  it("10,000 statement less a 1,000 outstanding check supports exactly 9,000 book", () => {
    expect(openingDifference("bank", 900000, 1000000, [check])).toBe(0);
    expect(openingDifference("bank", 900001, 1000000, [check])).toBe(1);
    expect(openingDifference("bank", 899999, 1000000, [check])).toBe(-1);
  });
  it("adds deposits in transit and subtracts outstanding checks once", () => {
    expect(openingDifference("bank", 912000, 1000000, [check, transit])).toBe(0);
    expect(openingDifference("bank", 912000, 1000000, [transit, check])).toBe(0);
    expect(openingDifference("bank", 888000, 1000000, [check, transit])).toBe(-24000);
  });
  it("does not count an already historical fee again in a net deposit in transit", () => {
    expect(openingDifference("bank", 1011800, 1000000, [{ kind: "deposit_in_transit", amount_cents: 11800 }])).toBe(0);
    expect(openingDifference("bank", 1012000, 1000000, [{ kind: "deposit_in_transit", amount_cents: 11800 }])).toBe(200);
  });
  it("supports overdrafts and explicit verified zero without defaulting unknown to zero", () => {
    expect(openingDifference("bank", -10000, 0, [{ kind: "outstanding_check", amount_cents: 10000 }])).toBe(0);
    expect(openingDifference("bank", 0, 0, [])).toBe(0);
    expect(openingDifference("bank", null, 0, [])).toBeNull();
    expect(openingDifference("bank", 0, null, [])).toBeNull();
  });
  it("UF baseline consists exactly of attested residual lots, independent of any statement", () => {
    const uf = [{ kind: "uf_receipt", amount_cents: 20000 }, { kind: "uf_receipt", amount_cents: 301 }];
    expect(openingDifference("clearing", 20301, null, uf)).toBe(0);
    expect(openingDifference("clearing", 50301, null, uf)).toBe(30000);
    expect(openingDifference("clearing", 20300, null, uf)).toBe(-1);
    expect(openingDifference("clearing", null, null, uf)).toBeNull();
  });
});

describe("opening book projection is baseline plus existing ledger movements with zero writes", () => {
  const baseline = { id: "baseline", revision: 2, kind: "bank", status: "adopted", setup_id: "setup",
    cut_date: "2000-01-01", bank_account_id: "bank", account_list_id: "bank-qb", currency: "USD",
    account_snapshot: { id: "bank-qb", name: "Bank", account_type: "Bank", currency: "USD" },
    book_balance_cents: 900000, statement_balance_cents: 900000, books_evidence_id: "books-pdf",
    statement_evidence_id: "statement-pdf", reference: "opening", adopted_by: "actor", adopted_at: "2000-01-01",
    revoked_by: null, revoked_at: null, revoke_reason: null } as OpeningBalance;
  function reader(status: OpeningBalance["status"], movements: string, balance: number | null = 900000) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = { query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("FROM bank_opening_balance WHERE id=")) return { rows: [{ ...baseline, status, book_balance_cents: balance }] };
      if (sql.includes("SELECT id FROM bank_opening_item")) return { rows: [] };
      if (sql.includes("FROM bank_opening_evidence")) return { rows: [{ id: "books-pdf" }, { id: "statement-pdf" }] };
      if (sql.includes("FROM bank_journal_line")) return { rows: [{ cents: movements }] };
      throw new Error(`Unexpected projection query ${sql}`);
    } } as unknown as PoolClient;
    return { client, queries };
  }
  it("adds a 500 deposit to book once and explicitly retains partial coverage", async () => {
    const db = reader("adopted", "50000");
    const context = await openingContext(db.client, "baseline");
    expect(context.current_book_balance_cents).toBe(950000);
    expect(context.movements_cents).toBe(50000);
    expect(context.zero_gl).toBe(true);
    expect(context.coverage).toBe("partial");
    expect(context.blockers).toEqual([]);
    expect(db.queries.every(query => query.sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(db.queries.find(query => query.sql.includes("FROM bank_journal_line"))?.values.slice(0, 2)).toEqual(["bank-qb", "2000-01-01"]);
  });
  it("old cleared checks add no new movement; reversed deposits net back to baseline", async () => {
    expect((await openingContext(reader("adopted", "0").client, "baseline")).current_book_balance_cents).toBe(900000);
    expect((await openingContext(reader("adopted", "-1").client, "baseline")).current_book_balance_cents).toBe(899999);
  });
  it.each<OpeningBalance["status"]>(["draft", "revoked"])("does not represent %s baseline as the current book", async status => {
    expect((await openingContext(reader(status, "50000").client, "baseline")).current_book_balance_cents).toBeNull();
  });
  it("unknown opening balance remains unresolved even when there are journal movements", async () => {
    const context = await openingContext(reader("draft", "50000", null).client, "baseline");
    expect(context.current_book_balance_cents).toBeNull();
    expect(context.blockers).toContain("BANKING_OPENING_BALANCE_UNKNOWN");
  });
});
