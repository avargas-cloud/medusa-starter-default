/**
 * The ONE definition of "active journal entry" shared by every GL report
 * (trial balance, register, P&L, balance sheet, sales tax, chart of accounts).
 *
 * An entry is active when it is neither a reversal nor reversed: a reversal
 * entry carries the MIRRORED lines of its target (`lib/ledger/post.ts`), so
 * excluding only the original — what trial-balance did until 2026-09-11 —
 * leaves the mirror standing and nets to −original instead of 0 (25 accounts,
 * Σ|Δ| 84,808,548 cents on the bankgl sandbox). Both halves of the pair go.
 *
 * `alias` is the `bank_journal_entry` alias in the caller's FROM clause. The
 * fragment binds nothing, so it is safe inside both knex `?` and pg `$n` SQL.
 */
export function activeEntryPredicate(alias = "e"): string {
  return (
    `${alias}.deleted_at IS NULL AND ${alias}.reverses_entry_id IS NULL ` +
    `AND NOT EXISTS (SELECT 1 FROM bank_journal_entry __r ` +
    `WHERE __r.reverses_entry_id = ${alias}.id AND __r.deleted_at IS NULL)`
  );
}
