/**
 * Case 03 · Categorize a debit (review mode=categorize, category "Utilities").
 * Writes ONE review draft on the operator's "EPT utilities test" movement. Idempotent by key (replay = same revision).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-03", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const tx = base.utilities; assert(tx, "utilities movement present");
  const lookup = await api.get("/admin/banking/lookups/accounts?q=Utilities");
  const utilities = (lookup.accounts as Json[]).find(a => a.name === "Utilities");
  assert(utilities, "QB expense account 'Utilities' available in the lookup");
  const before = record(tx.review);
  const journalBefore = await journalCount(pool);
  const body = { mode: "categorize", category_list_id: utilities.id, comment: "Caso 03 · categorize Utilities",
    expected_revision: Number(before?.revision ?? 0), expected_source_version: Number(tx.source_version) };
  const key = `case-03-${randomUUID()}`;
  const saved = await api.post(`/admin/banking/transactions/${tx.id}/review`, body, { "Idempotency-Key": key });
  const replay = await api.post(`/admin/banking/transactions/${tx.id}/review`, body, { "Idempotency-Key": key });
  const review = record(saved.review) ?? {};
  const detail = await api.get(`/admin/banking/transactions/${tx.id}/review`);
  const feedRow = (await baseAccount(api, pool)).utilities!;
  const events = (detail.events as Json[]).map(e => e.action);
  const journalAfter = await journalCount(pool);

  assert.equal(review.status, "draft"); assert.equal(review.mode, "categorize");
  assert.equal(review.category_list_id, utilities.id);
  assert.equal(record(review.category_snapshot)?.name, "Utilities");
  assert.equal(record(replay.review)?.revision, review.revision, "same Idempotency-Key replays, does not re-save");
  assert.equal(feedRow.review_status, "pending", "still 'To review' — a draft is not a confirmation");
  assert.equal(record(feedRow.review)?.category_list_id, utilities.id, "feed row shows the category");
  assert.equal(events.filter(a => a === "review_saved").length, 1, "one review_saved event");
  assert.equal(journalAfter, journalBefore, "categorize creates no journal entry");
  assert.equal(journalAfter, 0);

  block("Qué hice", { transaction_id: tx.id, movement: `${tx.date} ${tx.name} ${tx.amount}`, request: body, idempotency_key: key, replayed: true });
  block("Qué esperamos", { review: { status: review.status, mode: review.mode, revision: review.revision, category: record(review.category_snapshot), origin: review.origin, manual_override: review.manual_override, comment: review.comment },
    feed_row: { review_status: feedRow.review_status, category_list_id: record(feedRow.review)?.category_list_id }, events, bank_journal_entry: journalAfter });
  block("Mirá", "http://localhost:3099/accounting/banks → fila 2026-09-02 EPT utilities test · columna Match / Category");
});
