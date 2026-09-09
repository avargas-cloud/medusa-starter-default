/**
 * Case 07 · Exclude with a reason ("Duplicado del banco"), then restore (return) so the row stays usable for 08/09.
 * Proves: reason is mandatory, the row moves to Excluded with the reason visible to the auditor, edits are refused
 * until restored, an excluded row no longer blocks the day, and nothing is posted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-07", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).utilities!;
  const before = record(tx.review) ?? {};
  const versions = { expected_revision: Number(before.revision), expected_source_version: Number(tx.source_version) };
  const noReason = await api.call(`/admin/banking/transactions/${tx.id}/exclude`, { method: "POST", allow: [400], headers: { "Idempotency-Key": `case-07-${randomUUID()}` }, body: { ...versions } });
  assert.equal(noReason.status, 400, "exclude without a reason is refused");
  const reason = "Duplicado del banco";
  const excluded = record((await api.post(`/admin/banking/transactions/${tx.id}/exclude`, { ...versions, reason }, { "Idempotency-Key": `case-07-${randomUUID()}` })).review) ?? {};
  const rowExcluded = (await baseAccount(api, pool)).utilities!;
  const excludedTab = await api.get(`/admin/banking/transactions?account_id=${tx.account_id}&review_status=excluded&limit=50&offset=0`);
  const editWhileExcluded = await api.call(`/admin/banking/transactions/${tx.id}/review`, { method: "POST", allow: [409], headers: { "Idempotency-Key": `case-07-${randomUUID()}` },
    body: { mode: "categorize", category_list_id: before.category_list_id, comment: String(before.comment), expected_revision: Number(excluded.revision), expected_source_version: Number(tx.source_version) } });
  const dailyExcluded = await api.get("/admin/banking/daily?date=2026-09-02");
  // Restore so the row keeps serving cases 08 and 09.
  const restored = record((await api.post(`/admin/banking/transactions/${tx.id}/return`,
    { expected_revision: Number(excluded.revision), expected_source_version: Number(tx.source_version), reason: "Caso 07 · restaurar: no era duplicado" }, { "Idempotency-Key": `case-07-${randomUUID()}` })).review) ?? {};
  const rowRestored = (await baseAccount(api, pool)).utilities!;
  const events = ((await api.get(`/admin/banking/transactions/${tx.id}/review`)).events as Json[]).map(e => e.action);

  assert.equal(rowExcluded.review_status, "excluded"); assert.equal(excluded.exclusion_reason, reason);
  assert((excludedTab.transactions as Json[]).some(t => t.id === tx.id), "row listed in the Excluded tab");
  assert.equal(editWhileExcluded.status, 409); assert.equal(editWhileExcluded.body.code, "BANKING_RESTORE_REQUIRED");
  assert(!(dailyExcluded.blockers as string[]).some(b => /need review/.test(b)), "an excluded row does not block the day");
  assert.equal(rowRestored.review_status, "pending"); assert.equal(restored.exclusion_reason, null);
  assert.equal(record(restored.category_snapshot)?.name, "Utilities"); assert.equal(restored.counterparty_name, "FPL");
  assert.equal(await journalCount(pool), 0);

  block("Qué hice", { transaction_id: tx.id, steps: ["exclude SIN motivo → rechazado", `exclude reason="${reason}"`, "intento de editar la categoría estando excluida → rechazado", "return (restaurar) con motivo para dejar la fila usable en 08/09"], revisions: { before: before.revision, excluded: excluded.revision, restored: restored.revision } });
  block("Qué esperamos", { without_reason: { status: noReason.status, code: noReason.body.code },
    excluded: { status: excluded.status, exclusion_reason: excluded.exclusion_reason, in_excluded_tab: true, excluded_tab_count: excludedTab.count },
    edit_while_excluded: { status: editWhileExcluded.status, code: editWhileExcluded.body.code },
    daily_close_while_excluded: { blockers: dailyExcluded.blockers, can_close: dailyExcluded.can_close ?? null },
    restored: { status: restored.status, review_status: rowRestored.review_status, category: record(restored.category_snapshot)?.name, counterparty: restored.counterparty_name, exclusion_reason: restored.exclusion_reason },
    history: events, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → la fila está de vuelta en To review; en el historial (ícono de nota) se ven el exclude con 'Duplicado del banco' y la restauración. Para VER la pestaña Excluded en vivo: menú ··· de la fila → Exclude.");
});
