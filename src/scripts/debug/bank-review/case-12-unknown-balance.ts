/**
 * Case 12 · Saldo desconocido ≠ cero.
 *
 * `openingSaveSchema` declara book/statement_balance_cents como `.nullable()` pero
 * NO `.optional()`: null es "no lo sé" y es un valor legal de guardar; omitir el
 * campo es un request inválido. La regla que se verifica es que ese "no lo sé"
 * NUNCA se degrade a 0 — ni al guardar, ni al previsualizar, ni al adoptar.
 *
 * Tres brazos:
 *   A · omitir el campo            → 400, no se inventa nada
 *   B · null explícito             → el draft se guarda, pero preview/adopt lo BLOQUEAN
 *                                    con motivo nombrado; jamás difference_cents = 0
 *   C · 0 explícito (control +)    → cero es un saldo CONOCIDo y se acepta,
 *                                    o el brazo B no probaría nada
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, safeCode, record, type Json } from "./_lib";
import { tinyPdf } from "./_pdf";

const key = (tag: string) => ({ "Idempotency-Key": `case-12-${tag}-${randomUUID()}` });

void run("case-12", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const journalBefore = await journalCount(pool);

  // ── A · omitir el campo ────────────────────────────────────────────────────
  const omitted = await api.call("/admin/banking/accounting/openings", {
    method: "POST", headers: key("omit"), allow: [400, 409, 422],
    body: { expected_revision: 0, kind: "clearing", reference: "case-12 · sin monto", items: [] },
  });

  // Evidencia real: sin esto el preview muere en BANKING_OPENING_EVIDENCE_REQUIRED
  // —la valla ANTERIOR— y el caso no llega nunca a mirar el saldo.
  const upload = async (name: string, text: string) => record((await api.post(
    "/admin/banking/accounting/openings/evidence",
    { name, mime_type: "application/pdf", content_base64: tinyPdf(text).toString("base64") },
    key("ev"))).evidence)!;

  // ── B · null explícito, CON evidencia ──────────────────────────────────────
  const evB = await upload("case-12-uf-desconocido.pdf", "UF baseline al 2026-08-31 · saldo NO determinado");
  const saved = await api.call("/admin/banking/accounting/openings", {
    method: "POST", headers: key("null"), allow: [400, 409, 422],
    body: { expected_revision: 0, kind: "clearing", reference: "case-12 · saldo desconocido",
      book_balance_cents: null, statement_balance_cents: null, books_evidence_id: evB.id, items: [] },
  });
  let draft: Json = {}, blockersB: unknown = null, previewStatus = 0, previewCode = "UNKNOWN", diffB: unknown = null;
  if (saved.status === 200) {
    draft = record(saved.body.opening) ?? {};
    const ctx = await api.get(`/admin/banking/accounting/openings/${draft.id}`);
    blockersB = ctx.blockers ?? null; diffB = ctx.difference_cents ?? null;
    const p = await api.call(`/admin/banking/accounting/openings/${draft.id}/preview`, {
      method: "POST", headers: key("preview"), allow: [400, 409, 422],
      body: { expected_revision: Number(draft.revision) },
    });
    previewStatus = p.status; previewCode = safeCode(p.body.code ?? p.body.error);
  }

  // ── C · control positivo: 0 explícito ──────────────────────────────────────
  // clearing exige statement_balance_cents === null; el saldo que cuenta es el book.
  const evC = await upload("case-12-uf-cero.pdf", "UF baseline al 2026-08-31 · saldo CERO, conciliado");
  const zero = await api.call("/admin/banking/accounting/openings", {
    method: "POST", headers: key("zero"), allow: [400, 409, 422],
    body: { expected_revision: 0, kind: "clearing", reference: "case-12 · saldo CERO conocido",
      book_balance_cents: 0, statement_balance_cents: null, books_evidence_id: evC.id, items: [] },
  });
  let blockersC: unknown = null, diffC: unknown = null, previewC = 0;
  if (zero.status === 200) {
    const z = record(zero.body.opening) ?? {};
    const ctx = await api.get(`/admin/banking/accounting/openings/${z.id}`);
    blockersC = ctx.blockers ?? null; diffC = ctx.difference_cents ?? null;
    previewC = (await api.call(`/admin/banking/accounting/openings/${z.id}/preview`, {
      method: "POST", headers: key("previewC"), allow: [400, 409, 422],
      body: { expected_revision: Number(z.revision) } })).status;
  }

  const journalAfter = await journalCount(pool);

  // ── Aserciones ─────────────────────────────────────────────────────────────
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : [];
  assert.equal(omitted.status, 400, "A · omitir el saldo tiene que rechazarse");
  assert.equal(saved.status, 200, "B · null es un valor LEGAL de guardar (desconocido explícito)");
  assert.ok(list(blockersB).includes("BANKING_OPENING_BALANCE_UNKNOWN"),
    `B · el blocker tiene que ser el del SALDO, no otro. Vino: ${JSON.stringify(blockersB)}`);
  assert.ok(!list(blockersB).includes("BANKING_OPENING_EVIDENCE_REQUIRED"),
    "B · si todavía falta evidencia, el caso murió en la valla anterior y no prueba nada");
  assert.notEqual(diffB, 0, "B · el saldo desconocido JAMÁS se degrada a diferencia 0");
  assert.notEqual(previewStatus, 200, "B · no se puede previsualizar una apertura sin saldo");
  // Control positivo: si esto no pasa, el brazo B no acredita nada.
  assert.equal(zero.status, 200, "C · cero es un saldo CONOCIDO y se acepta");
  assert.ok(!list(blockersC).includes("BANKING_OPENING_BALANCE_UNKNOWN"),
    `C · cero no puede contar como desconocido. Vino: ${JSON.stringify(blockersC)}`);
  assert.equal(Number(diffC), 0, "C · con saldo 0 y sin partidas, la diferencia ES 0");
  assert.equal(journalAfter, journalBefore, "ningún brazo contabiliza nada");

  block("Qué hice", {
    script: "src/scripts/debug/bank-review/case-12-unknown-balance.ts",
    cuenta: `${base.name ?? base.id} (${base.id})`,
    A_omitir: "POST /admin/banking/accounting/openings SIN los campos de saldo",
    B_null: "POST clearing con book_balance_cents: null + PDF de evidencia → GET (blockers) → preview",
    C_cero: "POST clearing con book_balance_cents: 0 + PDF → GET → preview (CONTROL POSITIVO)",
  });
  block("Qué esperamos", {
    A_omitir: { status: omitted.status, code: safeCode(omitted.body.code ?? omitted.body.error) },
    B_null_desconocido: { guardado: saved.status, draft_id: draft.id, book: draft.book_balance_cents,
      statement: draft.statement_balance_cents, difference_cents: diffB, blockers: blockersB,
      preview: { status: previewStatus, code: previewCode } },
    C_cero_conocido: { guardado: zero.status, difference_cents: diffC, blockers: blockersC,
      preview_status: previewC },
    bank_journal_entry: { antes: journalBefore, despues: journalAfter },
  });
  block("Mirá", "http://localhost:3099/accounting/banks/openings → la apertura 'case-12 · saldo desconocido' queda en borrador y no ofrece adoptar; al lado, 'case-12 · saldo CERO conocido' sí es una apertura válida de cero.");
});
