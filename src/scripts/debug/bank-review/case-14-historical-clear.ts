/**
 * Case 14 · Clear histórico = 0 GL.
 *
 * El cheque 1042 ya estaba descontado en los libros de la apertura (book 9,000 = statement 10,000 − 1,000).
 * Cuando el banco lo paga (CHECK 1042 · 1,000.00 · 2026-09-05, fixture del caso 13), marcarlo como cobrado
 * es SOLO un enlace documental: el ítem pasa a cleared, el movimiento del feed queda "excluded" (no es
 * gasto nuevo), y NO nace ningún asiento. La proyección de libros de Chase sigue en 9,000.
 *
 * Control negativo: un segundo clear del mismo ítem (o contra el 999.99) se rechaza.
 * Idempotente: si el ítem ya está cleared, se verifica el estado sin volver a clearear.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, safeCode, type Json } from "./_lib";

const TX = "btxn_review_case13_chk1042";
const WRONG = "btxn_review_case13_chk1043";

void run("case-14", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const journalBefore = await journalCount(pool);
  const openings = ((await api.get("/admin/banking/accounting/openings")).openings as Json[] ?? []).map(c => record(c.opening));
  const adopted = openings.find(o => o?.kind === "bank" && o?.bank_account_id === base.id && o?.status === "adopted");
  assert(adopted, "BANK_OPENING_NOT_ADOPTED — run case-11 first");
  const before = await api.get(`/admin/banking/accounting/openings/${adopted.id}`);
  let item = ((before.items as Json[]) ?? []).find(i => i.external_key === "chk-1042")!;
  assert(item, "ITEM_CHK_1042_MISSING");
  const projectionBefore = before.current_book_balance_cents;

  // ── Clear (o reuso si ya está) ────────────────────────────────────────────
  let cleared: { status: number; body: Json };
  if (item.clear_id) {
    cleared = { status: 200, body: before };
  } else {
    const candidate = ((await api.get(`/admin/banking/accounting/openings/items/${item.id}/candidates`)).transactions as Json[] ?? []).find(c => c.id === TX);
    assert(candidate, "CANDIDATE_MISSING — run case-13 first");
    cleared = await api.call(`/admin/banking/accounting/openings/items/${item.id}/clear`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
      body: { transaction_id: TX, expected_source_version: Number(candidate.source_version), expected_item_hash: String(item.source_hash) },
    });
  }
  const after = await api.get(`/admin/banking/accounting/openings/${adopted.id}`);
  item = ((after.items as Json[]) ?? []).find(i => i.external_key === "chk-1042")!;

  // ── Control negativo: no se puede clearear dos veces ni contra el 999.99 ──
  const again = await api.call(`/admin/banking/accounting/openings/items/${item.id}/clear`, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, allow: [400, 409, 422],
    body: { transaction_id: WRONG, expected_source_version: 1, expected_item_hash: String(item.source_hash) },
  });

  const review = (await pool.query<{ status: string; exclusion_reason: string | null }>(
    "SELECT status, exclusion_reason FROM bank_transaction_review WHERE transaction_id=$1 AND deleted_at IS NULL", [TX])).rows[0];
  const clearRows = (await pool.query<{ n: string }>("SELECT count(*)::text n FROM bank_opening_clear WHERE item_id=$1 AND kind='clear'", [item.id])).rows[0]!.n;
  const journalAfter = await journalCount(pool);

  // ── Aserciones ─────────────────────────────────────────────────────────────
  assert.equal(cleared.status, 200, `el clear tiene que aceptarse: ${JSON.stringify(cleared.body).slice(0, 200)}`);
  assert.ok(item.clear_id, "el ítem queda CLEARED (enlazado al movimiento del feed)");
  assert.equal(item.transaction_id, TX, "enlazado exactamente al CHECK 1042 del feed");
  assert.equal(review?.status, "excluded", `el movimiento del feed queda 'excluded' (no es gasto nuevo). Vino: ${JSON.stringify(review)}`);
  assert.equal(journalAfter, journalBefore, "CERO asientos: el cheque ya estaba en los libros");
  assert.equal(after.current_book_balance_cents, projectionBefore, `la proyección de libros de Chase no se mueve (${projectionBefore})`);
  assert.equal(Number(clearRows), 1, "exactamente un registro de clear");
  assert.notEqual(again.status, 200, "un ítem ya cleared no se clearea de nuevo (control negativo)");

  block("Qué hice", {
    script: "src/scripts/debug/bank-review/case-14-historical-clear.ts",
    clear: `POST /admin/banking/accounting/openings/items/${item.id}/clear { transaction_id: ${TX} }`,
    control_negativo: `mismo ítem otra vez contra ${WRONG}`,
    reusado: Boolean(before.items && ((before.items as Json[]).find(i => i.external_key === "chk-1042") as Json).clear_id),
  });
  block("Qué esperamos", {
    item: { reference: item.reference, cleared: Boolean(item.clear_id), transaction_id: item.transaction_id },
    feed_review: review,
    bank_journal_entry: { antes: journalBefore, despues: journalAfter },
    book_projection_cents: { antes: projectionBefore, despues: after.current_book_balance_cents },
    segundo_clear: { status: again.status, code: safeCode(again.body.code ?? again.body.error) },
  });
  block("Mirá", `http://localhost:3099/accounting/banks/openings?opening_id=${adopted.id} → Check 1042 ya no dice Outstanding: queda enlazado al movimiento del 2026-09-05, con 'Undo historical clearing' disponible. En Banks, CHECK 1042 aparece en la pestaña Excluded con la razón 'Opening balance item…'. Movements: ningún asiento nuevo.`);
});
