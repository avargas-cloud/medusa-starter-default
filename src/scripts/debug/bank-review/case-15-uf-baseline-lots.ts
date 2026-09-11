/**
 * Case 15 · Apertura GLOBAL de Undeposited Funds con lotes.
 *
 * Al 31/8 había $500 cobrados y sin depositar. La apertura de UF no acepta "500" a secas: exige
 * decir DE QUÉ está hecho, lote por lote, y que los lotes sumen exacto:
 *   · lote A: cobro EXISTENTE del POS (cheque de $200 del 30/8, cpay_btx_review_case15_chk200)
 *   · lote B: fuente MANUAL de $300 con documento (cobros anteriores al POS, sin inventar un pago)
 *   → 200 + 300 = 500 = book → preview cuadra → adopt → 0 asientos.
 *
 * Controles negativos, cada uno con su motivo:
 *   · un lote que reclama $250 sobre el cheque de $200 → BANKING_OPENING_AMOUNT_INVALID (un cobro nunca aporta más de lo que tiene)
 *   · un cobro FECHADO después del corte (09-02)      → BANKING_OPENING_PAYMENT_DATE_INVALID (no es "anterior al corte")
 *   · con la global adoptada, otro borrador de UF      → BANKING_OPENING_ALREADY_ADOPTED (una sola UF global por corte)
 *
 * Idempotente: reusa la UF adoptada/borrador por referencia; los cpay se insertan con ON CONFLICT DO NOTHING.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, journalCount, record, safeCode, type Json } from "./_lib";
import { tinyPdf } from "./_pdf";

const CUSTOMER = "cus_01KG0Q2TGEMR410KKTCFNFYZJY"; // BRINZI CORP
const CPAY_OK = "cpay_btx_review_case15_chk200";     // 200 · 2026-08-30 · anterior al corte
const CPAY_LATE = "cpay_btx_review_case15_chk150";   // 150 · 2026-09-02 · POSTERIOR al corte (control)
const REF = "case-15 · UF global al 2026-08-31";
const key = (tag: string) => ({ "Idempotency-Key": `case-15-${tag}-${randomUUID()}` });

void run("case-15", async ({ api, pool }) => {
  const journalBefore = await journalCount(pool);
  const insert = async (id: string, cents: number, day: string, reference: string) => pool.query(
    `INSERT INTO customer_payment (id,customer_id,source,type,amount,currency,method,reference,status,received_at,batch_day,
       raw_amount,notes,created_by,created_at,updated_at,medusa_payment_synced,display_id)
     VALUES ($1,$2,'pos','payment',$3::numeric,'usd','check',$4,'available',($5||' 14:00:00+00')::timestamptz,$5::date,
       jsonb_build_object('value',$3::numeric::text,'precision',20),'Fixture revisión guiada Banking · caso 15','bank-review',now(),now(),false,(SELECT max(display_id)+1 FROM customer_payment))
     ON CONFLICT (id) DO NOTHING`, [id, CUSTOMER, cents, reference, day]); // customer_payment.amount se guarda en CENTAVOS (50000 = $500), como en el caso 09
  await insert(CPAY_OK, 20000, "2026-08-30", "CASO15 check 200 pre-corte");
  await insert(CPAY_LATE, 15000, "2026-09-02", "CASO15 check 150 post-corte");

  const upload = async (name: string, text: string) => record((await api.post("/admin/banking/accounting/openings/evidence",
    { name, mime_type: "application/pdf", content_base64: tinyPdf(text).toString("base64") }, key("ev"))).evidence)!;
  const openings = () => api.get("/admin/banking/accounting/openings").then(r => ((r.openings as Json[]) ?? []).map(c => record(c.opening)!));
  const existing = (await openings()).find(o => o.kind === "clearing" && o.reference === REF && o.status !== "revoked");

  let opening: Json;
  if (existing) {
    opening = existing;
  } else {
    const books = await upload("uf-libro-2026-08-31.pdf", "Undeposited Funds al 2026-08-31 · 500.00 = cheque 200 (BRINZI) + 300 cobros previos");
    const manual = await upload("uf-cobros-previos-300.pdf", "Cobros previos al POS sin depositar al 08-31 · 300.00");
    opening = record((await api.post("/admin/banking/accounting/openings", {
      expected_revision: 0, kind: "clearing", reference: REF, book_balance_cents: 50000, statement_balance_cents: null, books_evidence_id: books.id,
      items: [
        { kind: "uf_receipt", original_day: "2026-08-30", amount_cents: 20000, external_key: CPAY_OK, reference: "Cheque BRINZI 200", description: "cobro del POS, sin depositar", payment_id: CPAY_OK, evidence_id: books.id },
        { kind: "uf_receipt", original_day: "2026-08-29", amount_cents: 30000, external_key: "case15-manual-300", reference: "Cobros previos 300", description: "fuente manual con documento", payment_id: null, evidence_id: manual.id },
      ] }, key("save"))).opening)!;
  }

  // ── Controles negativos: el guard corre AL GUARDAR (409 con el motivo), no deja borrador ───
  const ev = await upload("uf-control.pdf", "control negativo caso 15");
  const tryLot = (reference: string, lot: Json) => api.call("/admin/banking/accounting/openings", {
    method: "POST", headers: key("control"), allow: [400, 409, 422],
    body: { expected_revision: 0, kind: "clearing", reference, book_balance_cents: Number(lot.amount_cents), statement_balance_cents: null, books_evidence_id: ev.id, items: [lot] },
  });
  const over = await tryLot("case-15 · control 250 sobre 200", { kind: "uf_receipt", original_day: "2026-08-30", amount_cents: 25000, external_key: `${CPAY_OK}-over`, reference: "reclama 250 sobre 200", description: "", payment_id: CPAY_OK, evidence_id: ev.id });
  const late = await tryLot("case-15 · control posterior al corte", { kind: "uf_receipt", original_day: "2026-08-31", amount_cents: 15000, external_key: CPAY_LATE, reference: "cobro posterior al corte", description: "", payment_id: CPAY_LATE, evidence_id: ev.id });
  // Un borrador VÁLIDO aparte (manual 100) sirve para probar que, con la global adoptada, no puede adoptarse otra.
  const controlRef = "case-15 · otra UF global (manual 100)";
  let control = (await openings()).find(o => o.kind === "clearing" && o.reference === controlRef && o.status === "draft");
  if (!control) {
    control = record((await api.post("/admin/banking/accounting/openings", {
      expected_revision: 0, kind: "clearing", reference: controlRef, book_balance_cents: 10000, statement_balance_cents: null, books_evidence_id: ev.id,
      items: [{ kind: "uf_receipt", original_day: "2026-08-28", amount_cents: 10000, external_key: "case15-manual-100", reference: "manual 100", description: "", payment_id: null, evidence_id: ev.id }] }, key("control2"))).opening)!;
  }

  // ── La buena: preview → adopt (si sigue en borrador) ──────────────────────
  let previewDiff: unknown = null;
  if (opening.status === "draft") {
    const p = record((await api.post(`/admin/banking/accounting/openings/${opening.id}/preview`, { expected_revision: Number(opening.revision) }, key("preview"))).preview)!;
    previewDiff = p.difference_cents;
    assert.equal(Number(p.difference_cents), 0, "200 + 300 tienen que sumar EXACTO el book de 500");
    opening = record((await api.post(`/admin/banking/accounting/openings/${opening.id}/adopt`,
      { expected_revision: Number(opening.revision), preview_hash: String(p.preview_hash), evidence_attested: true }, key("adopt"))).opening)!;
  }
  const final = await api.get(`/admin/banking/accounting/openings/${opening.id}`);
  const lots = (final.items as Json[]).map(i => ({ reference: i.reference, amount_cents: i.amount_cents, payment_id: i.payment_id, available_cents: i.available_cents, blockers: i.blockers }));

  // ── Con la global adoptada, el control no puede adoptarse ──────────────────
  const controlAfter = await api.get(`/admin/banking/accounting/openings/${control.id}`);
  const controlBlockers = (controlAfter.blockers as string[]) ?? [];
  const journalAfter = await journalCount(pool);

  // ── Aserciones ─────────────────────────────────────────────────────────────
  assert.equal(final.opening && (final.opening as Json).status, "adopted", "la UF global queda adoptada");
  assert.equal(lots.reduce((s, l) => s + Number(l.amount_cents), 0), 50000, "los lotes suman exacto 500");
  assert.equal(lots.find(l => l.payment_id === CPAY_OK)?.available_cents, 20000, "el lote del cheque aporta 200 disponibles para depositar");
  assert.equal(safeCode(over.body.code), "BANKING_OPENING_AMOUNT_INVALID", `250 sobre un cobro de 200 → se rechaza al guardar. Vino: ${over.status} ${JSON.stringify(over.body)}`);
  assert.equal(safeCode(late.body.code), "BANKING_OPENING_PAYMENT_DATE_INVALID", `cobro del 09-02 → se rechaza al guardar. Vino: ${late.status} ${JSON.stringify(late.body)}`);
  assert.ok(controlBlockers.includes("BANKING_OPENING_ALREADY_ADOPTED"), `otra UF con la global adoptada → ALREADY_ADOPTED. Vino: ${JSON.stringify(controlBlockers)}`);
  assert.equal(journalAfter, journalBefore, "adoptar la UF global no contabiliza nada");

  block("Qué hice", {
    script: "src/scripts/debug/bank-review/case-15-uf-baseline-lots.ts",
    cobros_fixture: { [CPAY_OK]: "200 · 2026-08-30 (anterior al corte)", [CPAY_LATE]: "150 · 2026-09-02 (posterior, control)" },
    apertura: { reference: REF, book: "500.00", lotes: ["cheque BRINZI 200 (payment_id)", "manual 300 con PDF"] },
    controles: ["POST con lote de 250 sobre el cheque de 200", "POST con cobro del 09-02", `borrador válido '${controlRef}' para probar la unicidad`],
    reusada: Boolean(existing),
  });
  block("Qué esperamos", {
    preview_difference_cents: previewDiff ?? "(ya adoptada)",
    lotes: lots,
    control_250_sobre_200: { status: over.status, code: safeCode(over.body.code) },
    control_posterior_al_corte: { status: late.status, code: safeCode(late.body.code) },
    otra_uf_global_blockers: controlBlockers,
    bank_journal_entry: { antes: journalBefore, despues: journalAfter },
  });
  block("Mirá", `http://localhost:3099/accounting/banks/openings → bloque Undeposited Funds: '${REF}' Adopted con 2 lotes (200 + 300); '${controlRef}' en borrador con 'Needs resolution' (ya hay una global adoptada); los borradores del caso 12 también quedan bloqueados (ya hay una UF global adoptada).`);
});
