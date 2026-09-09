import type { PoolClient } from "pg";
import { planRuleChanges, type ReviewRule } from "../../lib/banking/review-rule-apply";
import { dailyDifferences, dailyEvidence, type DailySnapshot } from "../../lib/banking/review-daily-read";
import { stableReviewHash } from "../../lib/banking/review-common";

const rule: ReviewRule = {
  id: "existing", version: 1, name: "Utilities", account_id: "a1", active: true, priority: 10,
  match_field: "description", pattern: "utilities", direction: "out", currency: "USD",
  category_list_id: "catA", counterparty_type: null, counterparty_id: null, counterparty_name: null,
};
const candidate: ReviewRule = { ...rule, id: "candidate", priority: 100, category_list_id: "catB" };
const source = { id: "t1", account_id: "a1", transaction_date: "2026-09-02", source_version: 1,
  amount: "125.50", currency: "USD", name: "utilities", merchant_name: null,
  setup_revision: 1, closed_revision: null, review: null };

function clientWithCategories(categories: string[]): PoolClient {
  return { query: async (sql: string) => {
    if (sql.includes("FROM bank_review_rule")) return { rows: [rule] };
    if (sql.includes("SELECT qb_list_id FROM qb_account")) return { rows: categories.map(qb_list_id => ({ qb_list_id })) };
    if (sql.includes("FROM bank_transaction t")) return { rows: [source] };
    throw new Error("Unexpected SQL in read-only preview test");
  } } as unknown as PoolClient;
}

function snapshot(): DailySnapshot {
  return { date: "2026-09-02", accounts: ["a1", "a2"].map(id => ({
    account: { id, connection_id: "c1", name: id, mask: "0042", type: "depository", subtype: "checking",
      currency: "USD", is_active: true, selected: true, qb_list_id: "bank", current_balance: "1500",
      available_balance: "1500", review_start_date: "2026-09-01", opening_bank_balance: "1500",
      opening_balance_date: "2026-08-31", opening_reference: "Statement", opening_book_balance: null, setup_revision: 1 },
    applicable: true, pending_count: 1, totals: [{ currency: "USD", money_in: "0", money_out: "125.50", net: "-125.50" }],
    transactions: [{ id: `t_${id}`, account_id: id, date: "2026-09-02", name: "utilities", merchant_name: null,
      amount: "-125.50", currency: "USD", status: "posted", source_version: 1, review: null,
      review_status: "pending", attachment_count: 0, day_closed: false, stale: false, attachments: [] }],
  })) };
}

describe("bank review evidence", () => {
  it("invalidates the approved preview when another category changes the winning rule", async () => {
    const before = await planRuleChanges(clientWithCategories(["catB"]), ["a1"], candidate);
    const after = await planRuleChanges(clientWithCategories(["catA", "catB"]), ["a1"], candidate);
    expect(before.changes[0]?.rule?.id).toBe("candidate");
    expect(after.changes[0]?.rule?.id).toBe("existing");
    expect(after.preview_hash).not.toBe(before.preview_hash);
  });

  it("does not depend on database category row order", async () => {
    const first = await planRuleChanges(clientWithCategories(["catA", "catB"]), ["a1"], candidate);
    const second = await planRuleChanges(clientWithCategories(["catB", "catA"]), ["a1"], candidate);
    expect(first.preview_hash).toBe(second.preview_hash);
  });

  it("ignores live balance, selection, name and presentation order in historical hashes", () => {
    const before = snapshot();
    const after = snapshot();
    after.accounts.reverse();
    for (const block of after.accounts) {
      block.account.current_balance = "9000";
      block.account.available_balance = "8500";
      block.account.selected = false;
      block.account.name = "Renamed";
      for (const row of block.transactions) { row.day_closed = true; row.review_status = "closed"; }
    }
    expect(stableReviewHash(dailyEvidence(before))).toBe(stableReviewHash(dailyEvidence(after)));
    expect(dailyDifferences(before, after)).toEqual({ added_transaction_ids: [], removed_transaction_ids: [],
      changed_transaction_ids: [], changed_account_ids: [] });
  });

  it("names monetary corrections, new rows and removed rows without altering the old snapshot", () => {
    const before = snapshot();
    const frozen = JSON.stringify(before);
    const after = snapshot();
    after.accounts[0]!.transactions[0]!.amount = "-126.50";
    after.accounts[0]!.transactions[0]!.source_version = 2;
    after.accounts[1]!.transactions[0]!.id = "new_row";
    expect(dailyDifferences(before, after)).toEqual({ added_transaction_ids: ["new_row"],
      removed_transaction_ids: ["t_a2"], changed_transaction_ids: ["t_a1"], changed_account_ids: [] });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
