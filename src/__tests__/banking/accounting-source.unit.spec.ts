import type { PoolClient } from "pg";
import { accountingSource } from "../../lib/banking/accounting-source";

const base = {
  id: "tx", account_id: "bank", account_name: "Checking", transaction_date: "2020-08-17",
  name: "Utility payment", amount: "120.01", currency: "USD", source_version: 1,
  status: "posted", deleted: false, account_currency: "USD", account_type: "depository",
  is_active: true, is_selected: true, review_start_date: "2020-01-01", opening_reference: "Verified opening",
  opening_bank_balance: "0", review_revision: 2, review_source_version: 1, review_status: "confirmed",
  mode: "categorize", category_list_id: "expense", qb_list_id: "bank-qb", counterparty_id: null,
  counterparty_type: null, category_snapshot: { id: "expense", name: "Utilities", account_type: "Expense" },
  rule_id: "rule", rule_version: 1, current_rule_version: 1, current_rule_active: true, comment: "Reviewed",
  day_closed: true, closed_review_revision: 2,
};
const accounts = [
  { id: "expense", name: "Utilities", account_type: "Expense", currency: "USD" },
  { id: "bank-qb", name: "Checking", account_type: "Bank", currency: "USD" },
];
async function read(overrides: Partial<typeof base> = {}, categoryCurrency: string | null = "USD", bankCurrency: string | null = "USD") {
  const client = { query: async (sql: string) => ({ rows: sql.includes("FROM bank_transaction t")
    ? [{ ...base, ...overrides }]
    : accounts.map(row => ({ ...row, currency: row.id === "expense" ? categoryCurrency : bankCurrency })) }) } as unknown as PoolClient;
  return accountingSource(client, "tx");
}

describe("immutable accounting evidence", () => {
  it("keeps a closed review valid when its rule is edited or paused for open days", async () => {
    const original = await read();
    const later = await read({ current_rule_version: 3, current_rule_active: false });
    expect(later.blockers).toEqual([]);
    expect(later.source_hash).toBe(original.source_hash);
  });
  it("daily close alone does not restate the accounting fingerprint", async () => {
    expect((await read({ day_closed: false })).source_hash).toBe((await read()).source_hash);
  });
  it("selection is availability, not a mutation of historical source evidence", async () => {
    const deselected = await read({ is_selected: false });
    expect(deselected.blockers).toContain("BANKING_EXPENSE_ACCOUNT_INACTIVE");
    expect(deselected.source_hash).toBe((await read()).source_hash);
  });
  it("blocks a changed review behind a frozen closed-day snapshot", async () => {
    expect((await read({ review_revision: 3 })).blockers).toContain("BANKING_EXPENSE_CLOSED_EVIDENCE_STALE");
  });
  it("tracks removed source and date edits without replacing snapshots", async () => {
    const original = await read();
    expect((await read({ status: "removed" })).source_hash).not.toBe(original.source_hash);
    expect((await read({ transaction_date: "2020-08-18" })).source_hash).not.toBe(original.source_hash);
  });
  it("unknown or foreign expense-account currency cannot post", async () => {
    expect((await read({}, "CAD")).blockers).toContain("BANKING_EXPENSE_CATEGORY_CURRENCY_INVALID");
    expect((await read({}, "")).blockers).toContain("BANKING_EXPENSE_CATEGORY_CURRENCY_INVALID");
  });
  it("accepts raw QB name and currency-less expense while freezing their provenance", async () => {
    const result = await read({}, null, "US Dollar");
    expect(result.blockers).toEqual([]);
    expect(result.source.category).toMatchObject({ currency: "USD", qb_currency_ref: null });
    expect(result.source.bank_account).toMatchObject({ currency: "USD", qb_currency_ref: "US Dollar" });
    expect((await read({}, null, null)).blockers).toContain("BANKING_EXPENSE_BANK_MAPPING_INVALID");
  });
  it("does not display malformed bank money as a zero expense", async () => {
    const result = await read({ amount: "1.001" });
    expect(result.source.amount_cents).toBeNull();
    expect(result.blockers).toContain("BANKING_EXPENSE_AMOUNT_INVALID");
  });
});
