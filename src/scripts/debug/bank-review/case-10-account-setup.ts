/**
 * Case 10 · Account setup: review starts 2026-09-01, bank balance at close of 2026-08-31, statement reference.
 * Balance derivation: Plaid current 1500.00 = balance at 08-31 − 125.50 + 500.00 → 1125.50 at 08-31.
 * Proves: the daily-close blocker disappears, setup is CAS-protected (stale revision → 409), future start → 400.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-10", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const accountBefore = ((await api.get("/admin/banking")).accounts as Json[]).find(a => a.id === base.id)!;
  const dailyBefore = await api.get("/admin/banking/daily?date=2026-09-02");
  const blockersBefore = (dailyBefore.blockers as string[]) ?? [];
  const body = { expected_revision: Number(accountBefore.setup_revision), review_start_date: "2026-09-01",
    opening_bank_balance: "1125.50", opening_reference: "First Platypus statement 2026-08-31", opening_book_balance: null };
  let saved: Json;
  if (accountBefore.review_start_date) {
    saved = { account: accountBefore, already_configured: true };
  } else {
    assert(blockersBefore.some(b => /opening balance/i.test(b)), "daily close is blocked by the missing setup before");
    saved = await api.post(`/admin/banking/accounts/${base.id}/setup`, body, { "Idempotency-Key": `case-10-${randomUUID()}` });
  }
  const account = record(saved.account) ?? {};
  const stale = await api.call(`/admin/banking/accounts/${base.id}/setup`, { method: "POST", allow: [409], headers: { "Idempotency-Key": `case-10-${randomUUID()}` },
    body: { ...body, expected_revision: 0 } });
  const future = await api.call(`/admin/banking/accounts/${base.id}/setup`, { method: "POST", allow: [400], headers: { "Idempotency-Key": `case-10-${randomUUID()}` },
    body: { ...body, expected_revision: Number(account.setup_revision), review_start_date: "2027-01-01" } });
  const overview = ((await api.get("/admin/banking")).accounts as Json[]).find(a => a.id === base.id)!;
  const dailyAfter = await api.get("/admin/banking/daily?date=2026-09-02");
  const blockersAfter = (dailyAfter.blockers as string[]) ?? [];

  assert.equal(overview.review_start_date, "2026-09-01"); assert.equal(overview.opening_balance_date, "2026-08-31");
  assert.equal(Number(overview.opening_bank_balance), 1125.5); assert.equal(overview.opening_reference, body.opening_reference);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "BANKING_REVIEW_CONFLICT");
  assert.equal(future.status, 400); assert.equal(future.body.code, "BANKING_FUTURE_START_DATE");
  assert(!blockersAfter.some(b => /opening balance/i.test(b)), "setup blocker gone");
  assert.equal(Number(overview.setup_revision), Number(account.setup_revision), "rejected requests did not bump the revision");
  assert.equal(await journalCount(pool), 0, "setup creates no accounting entry");

  block("Qué hice", { account_id: base.id, request: body, already_configured: saved.already_configured === true,
    rejected_requests: ["same body with expected_revision=0 (stale)", "review_start_date=2027-01-01 (future)"] });
  block("Qué esperamos", { account: { review_start_date: overview.review_start_date, opening_balance_date: overview.opening_balance_date, opening_bank_balance: overview.opening_bank_balance, opening_reference: overview.opening_reference, opening_book_balance: overview.opening_book_balance, setup_revision: overview.setup_revision },
    daily_close_2026_09_02: { blockers_before: blockersBefore, blockers_after: blockersAfter, can_close_after: dailyAfter.can_close ?? null },
    stale_revision: { status: stale.status, code: stale.body.code }, future_start: { status: future.status, code: future.body.code }, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → desaparece el aviso amarillo y Confirm se habilita; Manage connections → Review setup · EPT Sandbox checking; http://localhost:3099/accounting/banks/daily-close?date=2026-09-02");
});
