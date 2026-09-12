import { activeEntryPredicate } from "../../lib/ledger/reports/active-entries";

describe("activeEntryPredicate", () => {
  it("excludes BOTH halves of a reversed pair: the reversal and its target", () => {
    const sql = activeEntryPredicate("e");
    expect(sql).toContain("e.deleted_at IS NULL");
    expect(sql).toContain("e.reverses_entry_id IS NULL");
    expect(sql).toMatch(
      /NOT EXISTS \(SELECT 1 FROM bank_journal_entry __r WHERE __r\.reverses_entry_id = e\.id AND __r\.deleted_at IS NULL\)/
    );
  });

  it("uses the caller's alias everywhere and never a hardcoded one", () => {
    const sql = activeEntryPredicate("x");
    expect(sql).not.toMatch(/\be\./);
    expect(sql).toContain("x.reverses_entry_id IS NULL");
    expect(sql).toContain("__r.reverses_entry_id = x.id");
  });

  it("binds nothing (safe inside both knex `?` and pg `$n` statements)", () => {
    expect(activeEntryPredicate()).not.toContain("?");
    expect(activeEntryPredicate()).not.toMatch(/\$\d/);
  });
});
