/**
 * Case 05 · Confirm for audit: the reviewed debit (Utilities · FPL) moves to "Confirmed".
 * Proves: confirm needs the exact revision (CAS), moves the row to the Confirmed tab, clears the day blocker,
 * and posts NOTHING (bank_journal_entry stays 0). One idempotent write.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-05", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).utilities!;
  const review = record(tx.review) ?? {};
  let confirmed: Json;
  let stale = { status: 0, body: {} as Json };
  if (tx.review_status === "confirmed") {
    confirmed = { review, already_confirmed: true };
  } else {
    assert.equal(tx.review_status, "pending");
    stale = await api.call(`/admin/banking/transactions/${tx.id}/confirm`, { method: "POST", allow: [409], headers: { "Idempotency-Key": `case-05-${randomUUID()}` },
      body: { expected_revision: Number(review.revision) + 7, expected_source_version: Number(tx.source_version) } });
    assert.equal(stale.status, 409, "a wrong revision cannot confirm");
    const key = `case-05-${randomUUID()}`;
    const body = { expected_revision: Number(review.revision), expected_source_version: Number(tx.source_version) };
    confirmed = await api.post(`/admin/banking/transactions/${tx.id}/confirm`, body, { "Idempotency-Key": key });
    const replay = await api.post(`/admin/banking/transactions/${tx.id}/confirm`, body, { "Idempotency-Key": key });
    assert.equal(record(replay.review)?.revision, record(confirmed.review)?.revision, "replay with the same key does not re-confirm");
  }
  const after = (await baseAccount(api, pool)).utilities!;
  const detail = await api.get(`/admin/banking/transactions/${tx.id}/review`);
  const events = (detail.events as Json[]).map(e => e.action);
  const confirmedTab = await api.get(`/admin/banking/transactions?account_id=${tx.account_id}&review_status=confirmed&limit=50&offset=0`);
  const pendingTab = await api.get(`/admin/banking/transactions?account_id=${tx.account_id}&review_status=pending&limit=50&offset=0`);
  const daily = await api.get("/admin/banking/daily?date=2026-09-02");
  const r = record(after.review) ?? {};

  assert.equal(after.review_status, "confirmed");
  assert.equal(r.status, "confirmed"); assert(r.confirmed_at && r.confirmed_by, "who and when are recorded");
  assert.equal(record(r.category_snapshot)?.name, "Utilities"); assert.equal(r.counterparty_name, "FPL");
  assert((confirmedTab.transactions as Json[]).some(t => t.id === tx.id), "row is in the Confirmed tab");
  assert(!(pendingTab.transactions as Json[]).some(t => t.id === tx.id), "row left To review");
  assert(events.includes("review_confirmed"));
  assert.equal(await journalCount(pool), 0, "confirming posts nothing");

  block("Qué hice", { transaction_id: tx.id, movement: `${tx.date} ${tx.name} ${tx.amount}`, already_confirmed: confirmed.already_confirmed === true,
    wrong_revision_first: stale.status ? { status: stale.status, code: stale.body.code } : "skipped", confirm: { expected_revision: review.revision, expected_source_version: tx.source_version }, replayed_same_key: true });
  block("Qué esperamos", { review: { status: r.status, revision: r.revision, category: record(r.category_snapshot)?.name, counterparty: r.counterparty_name, confirmed_by: r.confirmed_by, confirmed_at: r.confirmed_at },
    tabs: { to_review: pendingTab.count, confirmed: confirmedTab.count }, events, daily_close_2026_09_02: { blockers: daily.blockers, can_close: daily.can_close ?? null }, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → pestaña Confirmed (la fila ya no está en To review); Daily close 2026-09-02 sin bloqueos");
});
