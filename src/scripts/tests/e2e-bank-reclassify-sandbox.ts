import assert from "node:assert/strict";

import { getDbPool } from "../../api/utils/db-pool";
import { reclassifyMatch } from "../../lib/banking/reclassification";
import { reconciledMatchesProjection } from "../../lib/banking/reconciled-matches";
import { requireBankingSandbox } from "../../lib/banking/security";
import { assertNoLaterClosedStatement } from "../../lib/banking/statement-core";
import { voidJournalEntry } from "../../lib/ledger/documents/journal-entry";

/**
 * bankfeed-correct-20260915 — Reclassification from a Reconciled feed row + the
 * reopen chain guard, against the sandbox copy (DB medusa on :5499, QB bridge
 * off). Fixture: the CLOSED March 2026 Amex 5009 statement, line MAILCHIMP
 * 03/30 = Check CHK-0109, counter line "Dues and Subscriptions" 26.50.
 *
 *   cd backend && env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ECOPOWERTECH_ENV=sandbox ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-reclassify-sandbox.ts
 *
 * Residue: the JEs it posts are VOIDED at the end (and any left by a killed run
 * are voided at the start), so a second run finds the same reclassifiable cap.
 */
let checks = 0;
const check = (ok: boolean, label: string): void => {
  assert(ok, label);
  checks++;
  console.log(`  ✓ ${label}`);
};
const ACTOR = "e2e-reclassify";
const MEMO_TAG = "E2E-RECLASS";

async function snapshotCounts(pool: ReturnType<typeof getDbPool>) {
  const r = (
    await pool.query<{ je: string; jel: string; bje: string; bjl: string; linked: string }>(
      `SELECT (SELECT COUNT(*) FROM gl_journal_entry) AS je,(SELECT COUNT(*) FROM gl_journal_entry_line) AS jel,
        (SELECT COUNT(*) FROM bank_journal_entry) AS bje,(SELECT COUNT(*) FROM bank_journal_line) AS bjl,
        (SELECT COUNT(*) FROM gl_journal_entry WHERE corrects_match_id IS NOT NULL) AS linked`
    )
  ).rows[0]!;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    // Sweep residue of a killed run: void every posted E2E reclassification.
    const stale = (
      await client.query<{ id: string }>(
        `SELECT id FROM gl_journal_entry WHERE memo LIKE $1 AND status='posted' AND deleted_at IS NULL`,
        [`${MEMO_TAG}%`]
      )
    ).rows;
    for (const row of stale) await voidJournalEntry(client, row.id, "e2e sweep", ACTOR);

    // ── Fixture: Mailchimp 03/30 on the closed March statement ─────────────────
    const fx = (
      await client.query<{ match_id: string; counter_line_id: string; counter_acct: string; transaction_id: string; statement_status: string }>(
        `SELECT m.id AS match_id,c.id AS counter_line_id,c.account_list_id AS counter_acct,sl.transaction_id,st.status AS statement_status
         FROM bank_statement_match m
         JOIN bank_statement_line sl ON sl.id=m.statement_line_id
         JOIN bank_statement st ON st.id=sl.statement_id
         JOIN bank_journal_line l ON l.id=m.book_id
         JOIN bank_journal_entry e ON e.id=l.entry_id AND e.source_kind='bank_check' AND e.day='2026-03-30'
         JOIN gl_check gc ON gc.id=e.source_id AND gc.payee_name='Mailchimp'
         JOIN bank_journal_line c ON c.entry_id=e.id AND c.account_snapshot->>'account_type'='Expense'
         WHERE m.deleted_at IS NULL LIMIT 1`
      )
    ).rows[0];
    assert(fx && fx.statement_status === "closed", "fixture: Mailchimp 03/30 matched on a CLOSED statement");
    const target = (
      await client.query<{ qb_list_id: string }>(
        `SELECT qb_list_id FROM qb_account WHERE account_type='Expense' AND is_active AND deleted_at IS NULL AND qb_list_id<>$1 ORDER BY full_name LIMIT 1`,
        [fx.counter_acct]
      )
    ).rows[0]!;
    const bank = (
      await client.query<{ qb_list_id: string }>(
        `SELECT qb_list_id FROM qb_account WHERE account_type IN ('Bank','CreditCard') AND is_active AND deleted_at IS NULL LIMIT 1`
      )
    ).rows[0]!;
    const base = { match_id: fx.match_id, counter_line_id: fx.counter_line_id, to_account_list_id: target.qb_list_id, day: "2026-09-15" };

    // ── Negative controls: every rejection leaves the ledger byte-identical ────
    const before = await snapshotCounts(pool);
    for (const [label, input, reason] of [
      ["target is a bank/card account", { ...base, to_account_list_id: bank.qb_list_id, amount_cents: 2650 }, "target_account_is_bank"],
      ["amount above the counter line", { ...base, amount_cents: 2651 }, "amount_exceeds_reclassifiable"],
      ["counter line of another entry", { ...base, counter_line_id: "bjl_not_this_entry", amount_cents: 1 }, "counter_line_not_in_entry"],
      ["dated in 2025", { ...base, day: "2025-12-31", amount_cents: 1 }, "day_before_2026"],
    ] as const) {
      let code = "", why = "";
      try {
        await reclassifyMatch(client, { ...input, memo: `${MEMO_TAG} negative` }, ACTOR);
      } catch (e) {
        const err = e as { code?: string; details?: { reason?: string } };
        code = err.code ?? ""; why = err.details?.reason ?? "";
      }
      check(code === "GL_SOURCE_INVALID" && why === reason, `rejects ${label} → GL_SOURCE_INVALID/${reason}`);
    }
    check(JSON.stringify(await snapshotCounts(pool)) === JSON.stringify(before), "rejections wrote NOTHING (gl_journal_entry, lines, bank_journal_entry, bank_journal_line, links unchanged)");

    // ── Positive: partial 20.00, then the remaining 6.50, then the cap bites ───
    const first = await reclassifyMatch(client, { ...base, amount_cents: 2000, memo: `${MEMO_TAG} partial` }, ACTOR);
    check(first.journal_entry.status === "posted" && /^JE-\d{4}$/.test(first.journal_entry.number), `posted ${first.journal_entry.number} for 20.00`);
    check(first.journal_entry.corrects_match_id === fx.match_id && first.journal_entry.corrects_line_id === fx.counter_line_id && first.journal_entry.correction_type === "reclassification", "JE is linked to the match, the counter line and typed 'reclassification'");
    const lines = first.journal_entry.lines;
    check(lines.length === 2 && lines.some((l) => l.account_list_id === target.qb_list_id && l.debit_cents === 2000) && lines.some((l) => l.account_list_id === fx.counter_acct && l.credit_cents === 2000), "Dr new account 20.00 / Cr Dues and Subscriptions 20.00 — no bank line");
    const glLines = (await client.query<{ t: string }>(`SELECT l.account_snapshot->>'account_type' AS t FROM bank_journal_line l WHERE l.entry_id=$1`, [first.entry_id])).rows.map((r) => r.t);
    check(glLines.length === 2 && !glLines.some((t) => t === "Bank" || t === "CreditCard"), "GL entry has exactly 2 lines and none is Bank/CreditCard");

    const [projected] = await reconciledMatchesProjection(client, [{ id: fx.transaction_id, reconciled: { statement_id: "x", from_day: "a", to_day: "b" } }]);
    const match = projected!.reconciled!.matches.find((m) => m.match_id === fx.match_id)!;
    check(match.counter_lines[0]!.reclassified_cents === 2000 && match.corrections.length === 1 && match.corrections[0]!.number === first.journal_entry.number, "feed row now carries reclassified_cents=2000 and the correction JE");

    const second = await reclassifyMatch(client, { ...base, amount_cents: 650, memo: `${MEMO_TAG} rest` }, ACTOR);
    check(second.journal_entry.status === "posted", `posted ${second.journal_entry.number} for the remaining 6.50`);
    let capped = "";
    try { await reclassifyMatch(client, { ...base, amount_cents: 1, memo: `${MEMO_TAG} over` }, ACTOR); } catch (e) { capped = (e as { details?: { reason?: string; reclassifiable_cents?: number } }).details?.reason ?? ""; }
    check(capped === "amount_exceeds_reclassifiable", "a third cent is refused: the line is fully reclassified (cap = counter − posted corrections)");

    // ── Reopen chain guard against real statements ───────────────────────────
    const jul = (await client.query<{ id: string; account_list_id: string; to_day: string }>(`SELECT st.id,st.account_list_id,st.to_day FROM bank_statement st JOIN bank_account a ON a.id=st.bank_account_id WHERE a.mask='7223' AND st.status='closed' AND st.from_day='2026-07-01'`)).rows[0]!;
    const aug = (await client.query<{ id: string; account_list_id: string; to_day: string }>(`SELECT st.id,st.account_list_id,st.to_day FROM bank_statement st JOIN bank_account a ON a.id=st.bank_account_id WHERE a.mask='7223' AND st.status='closed' AND st.from_day='2026-08-01'`)).rows[0]!;
    let guard = "";
    try { await assertNoLaterClosedStatement(client, { id: jul.id, account_list_id: jul.account_list_id, to: jul.to_day }); } catch (e) { guard = (e as { code?: string }).code ?? ""; }
    check(guard === "BANKING_STATEMENT_LATER_CLOSED", "reopen guard: July 7223 is blocked while August is closed");
    await assertNoLaterClosedStatement(client, { id: aug.id, account_list_id: aug.account_list_id, to: aug.to_day });
    check(true, "reopen guard: August 7223 (most recent) passes");

    // ── Cleanup: void both JEs; cap is free again ──────────────────────────────
    await voidJournalEntry(client, first.journal_entry.id, "e2e cleanup", ACTOR);
    await voidJournalEntry(client, second.journal_entry.id, "e2e cleanup", ACTOR);
    const [again] = await reconciledMatchesProjection(client, [{ id: fx.transaction_id, reconciled: { statement_id: "x", from_day: "a", to_day: "b" } }]);
    const m2 = again!.reconciled!.matches.find((m) => m.match_id === fx.match_id)!;
    check(m2.counter_lines[0]!.reclassified_cents === 0 && m2.corrections.length === 0, "voided corrections no longer count: reclassified_cents=0, corrections=[]");
    console.log(`\n${checks}/${checks} passed`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
