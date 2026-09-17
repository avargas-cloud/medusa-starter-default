/**
 * e2e-adopt-qb-bank-documents-sandbox.ts — adopción de los documentos bancarios de
 * QuickBooks (`qb_import` → `gl_check` / `gl_transfer` nativos) sobre un CLON de prod
 * DESECHABLE (plan adopt-qb-bank-documents-20260915).
 *
 *   psql …/postgres -c "CREATE DATABASE medusa_chk TEMPLATE medusa_cutover2"
 *   (+ medusa db:migrate + node scripts/run-custom-migrations.js sobre el clon)
 *   ECOPOWERTECH_ENV=sandbox QB_SYNC_ENABLED=true DISABLE_SCHEDULED_JOBS=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_chk' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-adopt-qb-bank-documents-sandbox.ts
 *
 * Qué afirma (todo con las MISMAS funciones que usa el script; nada de SQL de escritura
 * fuera de la migración, la adopción y los controles negativos):
 *   1. La migración aplica (idempotente) y el guard sigue rechazando lo de siempre:
 *      UPDATE de monto, de línea, DELETE de match, y un re-parent sin documento.
 *   2. Adoptar el lote entero NO cambia un byte de `bank_journal_line`, `bank_statement_match`,
 *      `bank_statement` (cerrados incluidos), ni la parte congelada de `bank_journal_entry`;
 *      los saldos por cuenta son idénticos; ningún extracto cerrado queda `needs_review`.
 *   3. Cada documento adoptado es dueño de su asiento (source_kind/source_id/document_number),
 *      su total = lo que el banco acreditó, la fila del pipeline está `confirmed` adoptada, la
 *      serie CHK-/TR- es cronológica y sin huecos, los contadores están al máximo, y el
 *      importador omite esos TxnIDs (`skip_posted_by_pos`) en cualquier fecha.
 *   4. Idempotente: una 2ª corrida adopta 0 y renumera 0.
 *   5. Mutation tests sobre el guard DESPUÉS de adoptar (monto, línea, match, re-parent ajeno,
 *      documento sin `qb_source='adopted'`).
 *   6. `--revert` devuelve todo byte a byte (textos del qb_import incluidos, números de los
 *      nativos, contadores) y una re-adopción posterior vuelve a dejar el estado final.
 *   7. Un adoptado de un mes ABIERTO se anula desde el POS: reversa + `gl_document_void` con
 *      el TxnID adoptado (QB es el espejo: el void viaja).
 */
import assert from "node:assert/strict";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { WRITE } from "../../lib/quickbooks/pipeline-status";
import { requireBankingSandbox } from "../../lib/banking/security";
import { statementContext } from "../../lib/banking/statement-read";
import { applyAdoption, revertAdoption, type AdoptionPlanItem } from "../../lib/ledger/adopt/apply";
import { classifyImportedBankDocument } from "../../lib/ledger/adopt/classify-imported";
import { loadImportedBankEntries } from "../../lib/ledger/adopt/load-imported";
import { resolvePayees } from "../../lib/ledger/adopt/payee";
import { checkAdoptionInvariants } from "../../lib/ledger/adopt/invariants";
import { planRenumber } from "../../lib/ledger/adopt/renumber";
import { voidBankCheck } from "../../lib/ledger/documents/bank-check";
import { classify, loadPosPostedTxnIds } from "../../lib/ledger/qb-import";
import { docLabelFor } from "../../lib/ledger/reports/doc-labels";
import { GlAdoptQbImport20260916000000 } from "../../migrations/Migration20260916000000-GlAdoptQbImport";

const WINDOW = { from: "2026-01-01", to: "2026-09-30" };
let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ✓ ${label}`); };

async function one<T>(client: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  return (await client.query(sql, params)).rows[0] as T;
}

interface Frozen { lines: string; matches: string; statements: string; entries: string; balances: string; texts: string; counters: string }
async function freeze(client: PoolClient): Promise<Frozen> {
  const h = async (sql: string) => (await one<{ h: string }>(client, sql)).h;
  return {
    lines: await h(`SELECT md5(string_agg(id||entry_id||role||account_list_id||debit_cents||credit_cents, ',' ORDER BY id)) AS h FROM bank_journal_line`),
    matches: await h(`SELECT md5(string_agg(id||statement_line_id||book_kind||book_id||amount_cents||book_hash||line_hash||COALESCE(deleted_at::text,''), ',' ORDER BY id)) AS h FROM bank_statement_match`),
    statements: await h(`SELECT md5(string_agg(id||status||from_day||to_day||revision||COALESCE(closed_snapshot::text,'')||COALESCE(input_hash,''), ',' ORDER BY id)) AS h FROM bank_statement`),
    entries: await h(`SELECT md5(string_agg(id||kind||day||amount_cents||source_hash||COALESCE(source_snapshot::text,'')||COALESCE(reverses_entry_id,'')||created_at::text, ',' ORDER BY id)) AS h FROM bank_journal_entry`),
    balances: await h(`SELECT md5(string_agg(account_list_id||':'||bal, ',' ORDER BY account_list_id)) AS h FROM (SELECT l.account_list_id, sum(l.debit_cents-l.credit_cents) bal FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id WHERE e.day<='2026-09-30' GROUP BY 1) b`),
    texts: await h(`SELECT md5(string_agg(id||source_kind||source_id||COALESCE(document_number,'')||reference||description, ',' ORDER BY id)) AS h FROM bank_journal_entry`),
    counters: await h(`SELECT md5(string_agg(name||value, ',' ORDER BY name)) AS h FROM document_number_counter WHERE name IN ('gl_check','gl_transfer')`),
  };
}

async function rejects(client: PoolClient, label: string, sql: string, params: unknown[], code: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql, params);
    assert.fail(`${label}: el guard NO rechazó`);
  } catch (e) {
    assert.match((e as Error).message, new RegExp(code), `${label}: mensaje inesperado — ${(e as Error).message}`);
  } finally {
    await client.query("ROLLBACK");
  }
  ok(`${label} → ${code}`);
}

async function guardNegatives(client: PoolClient, stage: string): Promise<void> {
  const entry = await one<{ id: string; line: string; match: string | null }>(client,
    `SELECT e.id, (SELECT id FROM bank_journal_line WHERE entry_id=e.id LIMIT 1) AS line,
            (SELECT m.id FROM bank_statement_match m JOIN bank_journal_line l ON l.id=m.book_id WHERE l.entry_id=e.id AND m.deleted_at IS NULL LIMIT 1) AS match
       FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' ORDER BY e.day LIMIT 1`);
  await rejects(client, `${stage}: UPDATE amount_cents`, `UPDATE bank_journal_entry SET amount_cents = amount_cents + 1 WHERE id=$1`, [entry.id], "BANKING_JOURNAL_IMMUTABLE");
  await rejects(client, `${stage}: UPDATE source_hash`, `UPDATE bank_journal_entry SET source_hash = 'x' WHERE id=$1`, [entry.id], "BANKING_JOURNAL_IMMUTABLE");
  await rejects(client, `${stage}: UPDATE línea`, `UPDATE bank_journal_line SET debit_cents = debit_cents + 1 WHERE id=$1`, [entry.line], "BANKING_JOURNAL_IMMUTABLE");
  await rejects(client, `${stage}: DELETE asiento`, `DELETE FROM bank_journal_entry WHERE id=$1`, [entry.id], "BANKING_JOURNAL_IMMUTABLE");
  await rejects(client, `${stage}: re-parent sin documento`, `UPDATE bank_journal_entry SET source_kind='bank_check', source_id='gchk_nope', document_number='CHK-9999' WHERE id=$1`, [entry.id], "BANKING_JOURNAL_IMMUTABLE");
  const anyMatch = entry.match ?? (await one<{ id: string }>(client, `SELECT id FROM bank_statement_match WHERE deleted_at IS NULL LIMIT 1`)).id;
  await rejects(client, `${stage}: DELETE match`, `DELETE FROM bank_statement_match WHERE id=$1`, [anyMatch], "BANKING_STATEMENT_MATCH_IMMUTABLE");
}

async function buildPlan(client: PoolClient): Promise<AdoptionPlanItem[]> {
  const loaded = await loadImportedBankEntries(client, WINDOW);
  const items = loaded.entries.filter((e) => !loaded.already.has(e.txn_id)).map((entry) => ({ entry, decision: classifyImportedBankDocument(entry) }));
  const pending = items.filter((i) => i.decision.target !== "unmapped");
  const payees = await resolvePayees(client, pending.map((p) => p.entry), { source: "snapshot", cacheDir: "/nonexistent", ...WINDOW, log: () => undefined });
  return pending.map((p) => ({ entry: p.entry, decision: p.decision, payee: payees.get(p.entry.txn_id) ?? null }));
}

async function closedStatementsClean(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM bank_statement WHERE status='closed' AND deleted_at IS NULL ORDER BY account_list_id, from_day`);
  for (const s of rows) {
    const ctx = await statementContext(client, s.id);
    assert.equal(ctx.needs_review, false, `extracto ${s.id} needs_review`);
    assert.ok(!ctx.blockers.includes("BANKING_STATEMENT_MATCH_SOURCE_DRIFT"), `extracto ${s.id} con drift`);
  }
  return rows.length;
}

async function assertAdoptedShape(client: PoolClient): Promise<{ checks: number; transfers: number }> {
  const r = await checkAdoptionInvariants(client);
  assert.deepEqual(r.failures, [], "invariantes de adopción");
  return { checks: r.checks, transfers: r.transfers };
}

async function main(): Promise<void> {
  requireBankingSandbox();
  const client = await getDbPool().connect();
  const actor = (await one<{ id: string }>(client, `SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`)).id;
  try {
    // ── 1. migración (idempotente) + guard intacto ANTES ──────────────────────────
    const runner = { query: (sql: string) => client.query(sql) };
    await new GlAdoptQbImport20260916000000().up(runner as never);
    await new GlAdoptQbImport20260916000000().up(runner as never);
    ok("migración GlAdoptQbImport aplicada dos veces sin error (idempotente)");
    await guardNegatives(client, "antes");

    const before = await freeze(client);
    const closedBefore = await closedStatementsClean(client);
    ok(`${closedBefore} extractos cerrados sin needs_review antes`);
    const qbTexts = await one<{ h: string }>(client, `SELECT md5(string_agg(id||document_number||reference||description, ',' ORDER BY id)) AS h FROM bank_journal_entry WHERE source_kind='qb_import'`);

    // ── 2-3. adopción del lote ────────────────────────────────────────────────────
    const plan = await buildPlan(client);
    assert.ok(plan.length > 800, `plan chico: ${plan.length}`);
    const renumber = await planRenumber(client, plan);
    const result = await applyAdoption(client, { plan, renumber, actorId: actor });
    ok(`adoptados ${result.adopted.gl_check} gl_check + ${result.adopted.gl_transfer} gl_transfer · renumerados ${result.renumbered}`);
    const after = await freeze(client);
    for (const k of ["lines", "matches", "statements", "entries", "balances"] as const) assert.equal(after[k], before[k], `${k} cambió`);
    ok("líneas, matches, extractos, parte congelada de los asientos y saldos por cuenta: byte a byte iguales");
    assert.notEqual(after.texts, before.texts);
    const closedAfter = await closedStatementsClean(client);
    assert.equal(closedAfter, closedBefore);
    ok(`${closedAfter} extractos cerrados sin needs_review ni drift después`);
    const shape = await assertAdoptedShape(client);
    ok(`forma: ${shape.checks} cheques + ${shape.transfers} transfers dueños de su asiento; series CHK/TR cronológicas sin huecos; contadores al máximo`);
    const label = await one<{ source_kind: string; document_number: string; payee_name: string }>(client,
      `SELECT e.source_kind, e.document_number, c.payee_name FROM bank_journal_entry e JOIN gl_check c ON c.id=e.source_id WHERE e.source_kind='bank_check' AND c.qb_source='adopted' ORDER BY e.day LIMIT 1`);
    assert.match(docLabelFor(label.source_kind, label.document_number), /^Check CHK-\d{4}$/);
    ok(`Register etiqueta "${docLabelFor(label.source_kind, label.document_number)} · ${label.payee_name}"`);
    const posted = await loadPosPostedTxnIds(client);
    const sample = plan[0]!.entry;
    assert.ok(posted.has(sample.txn_id));
    assert.equal(classify(sample.txn_type, sample.day, undefined, true, posted.has(sample.txn_id)).action, "skip_posted_by_pos");
    assert.equal(classify(sample.txn_type, "2026-01-05", undefined, true, true).action, "skip_posted_by_pos");
    const remaining = await loadImportedBankEntries(client, WINDOW);
    assert.equal(remaining.entries.filter((e) => !remaining.already.has(e.txn_id) && classifyImportedBankDocument(e).target !== "unmapped").length, 0);
    ok("importador: los TxnIDs adoptados se omiten en cualquier fecha; no queda nada adoptable");

    // ── 4. idempotencia ───────────────────────────────────────────────────────────
    const plan2 = await buildPlan(client);
    const r2 = await applyAdoption(client, { plan: plan2, renumber: await planRenumber(client, plan2), actorId: actor });
    assert.deepEqual([plan2.length, r2.adopted.gl_check, r2.adopted.gl_transfer, r2.renumbered], [0, 0, 0, 0]);
    const afterTwice = await freeze(client);
    assert.deepEqual(afterTwice, after);
    ok("2ª corrida: 0 adoptados, 0 renumerados, estado idéntico");

    // ── 5. mutation tests DESPUÉS ─────────────────────────────────────────────────
    await guardNegatives(client, "después");
    const adopted = await one<{ entry_id: string; id: string; other: string }>(client,
      `SELECT c.entry_id, c.id, (SELECT id FROM gl_check WHERE id<>c.id AND deleted_at IS NULL LIMIT 1) AS other FROM gl_check c WHERE c.qb_source='adopted' AND c.deleted_at IS NULL LIMIT 1`);
    await rejects(client, "después: re-parent a OTRO documento", `UPDATE bank_journal_entry SET source_id=$2 WHERE id=$1`, [adopted.entry_id, adopted.other], "BANKING_JOURNAL_IMMUTABLE");
    await rejects(client, "después: renumber a un número que no es el del documento", `UPDATE bank_journal_entry SET document_number='CHK-0000' WHERE id=$1`, [adopted.entry_id], "BANKING_JOURNAL_IMMUTABLE");
    await rejects(client, "después: vuelta a qb_import con el documento VIVO", `UPDATE bank_journal_entry SET source_kind='qb_import', source_id=(SELECT qb_txn_id FROM gl_check WHERE id=$2), document_number='x' WHERE id=$1`, [adopted.entry_id, adopted.id], "BANKING_JOURNAL_IMMUTABLE");
    // documento sin qb_source='adopted' apuntando a un qb_import: la arista adopt lo rechaza
    const importedLeft = await one<{ id: string; source_id: string; day: string; bank: string }>(client,
      `SELECT e.id, e.source_id, e.day, (SELECT account_list_id FROM bank_journal_line WHERE entry_id=e.id AND credit_cents>0 LIMIT 1) AS bank
         FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' AND e.day>='2026-01-01' ORDER BY e.day LIMIT 1`);
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO gl_check (id, doc_number, kind, day, bank_account_list_id, bank_account_snapshot, payee_type, payee_name, total_cents, status, entry_id, created_by, qb_txn_id)
        VALUES ('gchk_e2e_noadopt','tmp:gchk_e2e_noadopt','expense',$1::date,$2,'{}'::jsonb,'other','x',1,'posted',$3,$4,$5)`, [importedLeft.day, importedLeft.bank, importedLeft.id, actor, importedLeft.source_id]);
      await assert.rejects(client.query(`UPDATE bank_journal_entry SET source_kind='bank_check', source_id='gchk_e2e_noadopt', document_number='tmp:gchk_e2e_noadopt' WHERE id=$1`, [importedLeft.id]), /BANKING_JOURNAL_IMMUTABLE/);
    } finally {
      await client.query("ROLLBACK");
    }
    ok("después: un documento sin qb_source='adopted' no puede re-parentar un qb_import");

    // ── 6. revert byte a byte + re-adopción ───────────────────────────────────────
    const rev = await revertAdoption(client, { ...WINDOW, renumber: result.renumberMap, actorId: actor });
    assert.equal(rev.reverted, result.adopted.gl_check + result.adopted.gl_transfer);
    const reverted = await freeze(client);
    assert.deepEqual(reverted, before, "revert no devolvió el estado inicial");
    const qbTextsAfter = await one<{ h: string }>(client, `SELECT md5(string_agg(id||document_number||reference||description, ',' ORDER BY id)) AS h FROM bank_journal_entry WHERE source_kind='qb_import'`);
    assert.equal(qbTextsAfter.h, qbTexts.h, "los textos de los qb_import no volvieron idénticos");
    const skipped = await one<{ n: string }>(client, `SELECT count(*)::text AS n FROM qb_order_pipeline WHERE step='gl_document_add' AND qb_result->>'adopted'='true' AND status='${WRITE.sales.skipped}'`);
    assert.equal(Number(skipped.n), rev.reverted);
    ok(`revert: ${rev.reverted} asientos de vuelta a qb_import, textos/números/contadores idénticos al inicio, ${skipped.n} filas skipped`);
    const plan3 = await buildPlan(client);
    const r3 = await applyAdoption(client, { plan: plan3, renumber: await planRenumber(client, plan3), actorId: actor });
    assert.equal(r3.adopted.gl_check + r3.adopted.gl_transfer, rev.reverted);
    const readopted = await freeze(client);
    assert.deepEqual({ ...readopted, texts: "", entries: "" }, { ...after, texts: "", entries: "" });
    await assertAdoptedShape(client);
    ok("re-adopción tras el revert: mismo estado final (líneas/matches/extractos/saldos/contadores)");

    // ── 7. void de un adoptado en mes abierto: el POS opera, QB es el espejo ──────
    const sept = await one<{ id: string; doc_number: string; qb_txn_id: string }>(client,
      `SELECT id, doc_number, qb_txn_id FROM gl_check WHERE qb_source='adopted' AND deleted_at IS NULL AND status='posted' AND day >= '2026-09-01' ORDER BY day DESC LIMIT 1`);
    assert.ok(sept, "hace falta un adoptado de septiembre (mes abierto)");
    const voided = await voidBankCheck(client, sept.id, "e2e: anulación de un adoptado", actor);
    assert.equal(voided.status, "voided"); // entity-status
    const reversal = await one<{ n: string; label: string }>(client, `SELECT count(*)::text AS n, max(document_number) AS label FROM bank_journal_entry WHERE kind='reversal' AND source_kind='bank_check' AND source_id=$1`, [sept.id]);
    assert.equal(reversal.n, "1");
    assert.equal(reversal.label, sept.doc_number);
    const voidRow = await one<{ status: string; qb_txn_id: string }>(client, `SELECT status, qb_txn_id FROM qb_order_pipeline WHERE step='gl_document_void' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`, [sept.id]);
    assert.ok(voidRow, "sin fila gl_document_void");
    assert.equal(voidRow.qb_txn_id, sept.qb_txn_id);
    ok(`void de ${sept.doc_number} (adoptado, septiembre): reversa posteada + TxnVoid encolado (${voidRow.status}) con el TxnID adoptado`);

    console.log(`\ne2e-adopt-qb-bank-documents: ${passed}/${passed} OK`);
  } finally {
    client.release();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error(`\n✗ e2e-adopt-qb-bank-documents falló tras ${passed} checks:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
