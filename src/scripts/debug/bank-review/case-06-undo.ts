/**
 * Case 06 · Undo (return to review) with a reason: the confirmed Utilities row goes back to "To review".
 * Proves: the category, counterparty and comment survive; the history keeps the confirm AND the return with its reason.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-06", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).utilities!;
  const before = record(tx.review) ?? {};
  const eventsBefore = ((await api.get(`/admin/banking/transactions/${tx.id}/review`)).events as Json[]).map(e => e.action);
  assert.equal(tx.review_status, "confirmed", "case 05 left the row confirmed");
  const reason = "Caso 06 · revisar la contraparte antes de cerrar";
  const returned = await api.post(`/admin/banking/transactions/${tx.id}/return`,
    { expected_revision: Number(before.revision), expected_source_version: Number(tx.source_version), reason }, { "Idempotency-Key": `case-06-${randomUUID()}` });
  const after = (await baseAccount(api, pool)).utilities!;
  const r = record(after.review) ?? {};
  const detail = await api.get(`/admin/banking/transactions/${tx.id}/review`);
  const events = (detail.events as Json[]).map(e => ({ action: e.action, details: e.details }));
  const daily = await api.get("/admin/banking/daily?date=2026-09-02");

  assert.equal(after.review_status, "pending"); assert.equal(r.status, "draft");
  assert.equal(record(r.category_snapshot)?.name, "Utilities", "category kept");
  assert.equal(r.counterparty_name, "FPL", "counterparty kept"); assert.equal(r.comment, before.comment, "comment kept");
  assert.equal(r.confirmed_at, null); assert.equal(r.confirmed_by, null);
  assert(eventsBefore.includes("review_confirmed") && events.some(e => e.action === "review_confirmed"), "the previous confirm stays in history");
  const ret = events.find(e => /return/.test(String(e.action)));
  assert(ret && JSON.stringify(ret.details).includes(reason), "the return event carries the reason");
  assert((daily.blockers as string[]).some(b => /need review/.test(b)), "day is blocked again");
  assert.equal(await journalCount(pool), 0);

  block("Qué hice", { transaction_id: tx.id, request: { route: "POST /admin/banking/transactions/:id/return", expected_revision: before.revision, reason }, revision_before: before.revision, revision_after: r.revision });
  block("Qué esperamos", { review: { status: r.status, revision: r.revision, category: record(r.category_snapshot)?.name, counterparty: r.counterparty_name, comment: r.comment, confirmed_by: r.confirmed_by },
    history: events, daily_close_2026_09_02: { blockers: daily.blockers, can_close: daily.can_close ?? null }, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → la fila volvió a To review con Utilities/FPL intactos; ícono de nota → historial con el confirm y el undo con motivo");
});
