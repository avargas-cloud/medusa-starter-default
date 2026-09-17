/**
 * e2e-bank-feed-suggestions-sandbox.ts — plan bank-feed-suggestions-20260915, Fases 3 y 4.
 * Contra un clon DESECHABLE de prod (`medusa_sug`, migrado). Usa la Wells 1221 REAL del clon
 * (borrador 09/01→09/15 casado 6/6) y líneas SINTÉTICAS del feed para lo que el libro no tiene.
 *
 *   ECOPOWERTECH_ENV=sandbox GL_POSTING_ENABLED=true QB_SYNC_ENABLED=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_sug' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-feed-suggestions-sandbox.ts
 *
 * Fase 3 — runner:
 *   1. Corrida manual sobre Wells: extiende el borrador (líneas nuevas sintéticas del 09/12 entran,
 *      las 6 casadas siguen casadas con el MISMO id), persiste una sugerencia por línea, métricas.
 *   2. Segunda corrida idéntica: 0 líneas agregadas, 0 matches nuevos (nunca hubo), sugerencias iguales.
 *   3. Extracto CERRADO (Wells agosto): la corrida lo saltea con `closed` y sus bytes no cambian.
 *   4. Una línea sintética cuyo asiento existe (cheque partido: 2 líneas = 1 asiento) sale sugerida
 *      `match`/`bank_sum` con `expected_book_hash`; una línea sin asiento sale `none`.
 *   NEGATIVO: el runner no escribe NINGÚN bank_statement_match ni gl_check (conteos antes/después).
 * Fase 4 — Confirm del contador (mismas fixtures):
 *   5. Confirm-match de la parte A del cheque partido → bank_statement_match, la fila del feed sale
 *      `reconciled` (draft) y las sugerencias se recalculan (la parte B sigue sugerida).
 *   6. Ambigua (dos cheques del mismo monto a la misma distancia, referencias distintas): sale
 *      `ambiguous` con 2 alternativas y NO tiene match; el contador elige una y confirma.
 *   7. Confirm-categoría de la línea sin documento (salida) → preview (kind expense, Check a QB) →
 *      gl_check posteado + fila qb_order_pipeline gl_document_add + match; hash del preview viejo → 409.
 *   8. Entrada con categoría → gl_journal_entry Dr banco / Cr cuenta + JournalEntryAdd + match.
 *   9. El Confirm viejo (bank_transaction_review) sobre una línea de extracto → 409 CONFIRM_VIA_MATCH.
 *  10. Un día con una línea PENDING del banco no cierra (bloqueo nombrado).
 *   NEGATIVO: el hash de un asiento cambiado → BANKING_STATEMENT_MATCH_SOURCE_DRIFT (409), sin match.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { getDbPool } from "../../api/utils/db-pool";
import { WRITE } from "../../lib/quickbooks/pipeline-status";
import { requireBankingSandbox } from "../../lib/banking/security";
import { listSuggestionAccounts, runSuggestionsForMonth } from "../../lib/banking/suggestion-runner";
import { readFeedSuggestions } from "../../lib/banking/suggestion-store";

let checks = 0;
const check = (ok: boolean, label: string): void => { assert(ok, label); checks++; console.log(`  ✓ ${label}`); };
const ACTOR = "system";

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query<T>(sql, params)).rows;
  const wells = (await q<{ id: string; connection_id: string; qb_list_id: string }>(`SELECT id,connection_id,qb_list_id FROM bank_account WHERE mask='1221' AND type='depository' AND is_selected AND deleted_at IS NULL`))[0];
  assert(wells, "Wells 1221 existe en el clon");
  await pool.query(`UPDATE bank_connection SET status='active', last_successful_sync_at=now() WHERE deleted_at IS NULL`);
  const [account] = await listSuggestionAccounts([wells.id]);
  assert(account, "Wells es elegible para el runner");
  const RUN = Date.now().toString(36);
  const sep = (await q<{ id: string; revision: number; to_day: string }>(`SELECT id,revision,to_day::text AS to_day FROM bank_statement WHERE bank_account_id=$1 AND from_day='2026-09-01' AND deleted_at IS NULL`, [wells.id]))[0];
  assert(sep, "Wells tiene el borrador de septiembre");
  const matchedBefore = await q<{ line_id: string; book_id: string }>(`SELECT m.statement_line_id AS line_id,m.book_id FROM bank_statement_match m WHERE m.statement_id=$1 AND m.deleted_at IS NULL ORDER BY 1,2`, [sep.id]);
  const countMatches = async (): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM bank_statement_match WHERE deleted_at IS NULL`))[0]!.n);
  const countChecks = async (): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM gl_check`))[0]!.n);
  const m0 = await countMatches(), c0 = await countChecks();
  const linesBefore = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM bank_statement_line WHERE statement_id=$1 AND deleted_at IS NULL`, [sep.id]))[0]!.n);

  // Fixture: un cheque del libro partido en DOS líneas del banco ($600 = $450 + $150) y una línea sin asiento.
  const dayNew = "2026-09-12";
  const insertTx = async (id: string, amount: string, name: string): Promise<void> => {
    await pool.query(
      `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,merchant_name,source_data,first_seen_at,last_seen_at)
       VALUES($1,$2,$3,$1,$4,'USD','posted',$5,$6,$6,'{}',now(),now())`, [id, wells.connection_id, wells.id, amount, dayNew, name]);
  };
  // Montos únicos por corrida: dos fixtures iguales en el clon serían intercambiables y el test no
  // podría afirmar a cuál cheque apunta la sugerencia.
  const salt = Date.now() % 89; // centavos
  const partA = 45000 + salt, partB = 15000 + salt, total = partA + partB;
  const splitA = `e2e_sug_${RUN}_a`, splitB = `e2e_sug_${RUN}_b`, orphan = `e2e_sug_${RUN}_o`;
  await insertTx(splitA, (partA / 100).toFixed(2), "CHECK # 990 PART 1");
  await insertTx(splitB, (partB / 100).toFixed(2), "CHECK # 990 PART 2");
  await insertTx(orphan, "15.00", "MONTHLY SERVICE FEE E2E (sin documento)");
  // El asiento del libro: un gl_check posteado de $600 a Wells (kind check, nº 990).
  const { createBankCheck, postBankCheck } = await import("../../lib/ledger");
  const expenseAcct = (await q<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Expense' ORDER BY full_name LIMIT 1`))[0]!.qb_list_id;
  const cl = await pool.connect();
  let checkId: string;
  try {
    const user = (await q<{ id: string }>(`SELECT id FROM "user" WHERE email='contador@test.com'`))[0]!.id;
    const chk = await createBankCheck(cl, { day: dayNew, bank_account_list_id: wells.qb_list_id, number: "990", payee_type: "other", payee_name: "E2E Split Payee", memo: `e2e ${RUN}`, to_be_printed: false, lines: [{ account_list_id: expenseAcct, amount_cents: BigInt(total), memo: "e2e split" }] }, user);
    await postBankCheck(cl, chk.id, user);
    checkId = chk.id;
  } finally { cl.release(); }
  const c1 = await countChecks();
  check(c1 === c0 + 1, "fixture: un gl_check posteado (el libro tiene el cheque, el banco lo muestra en dos partes)");

  // 1. Primera corrida.
  const r1 = await runSuggestionsForMonth(account, "2026-09", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  assert(r1.outcome.status === "ok", `corrida 1: ${JSON.stringify(r1.outcome)}`);
  check(r1.outcome.appended_lines === 3, `corrida 1: 3 líneas nuevas agregadas al borrador (appended=${r1.outcome.appended_lines})`);
  const matchedAfter = await q<{ line_id: string; book_id: string }>(`SELECT m.statement_line_id AS line_id,m.book_id FROM bank_statement_match m WHERE m.statement_id=$1 AND m.deleted_at IS NULL ORDER BY 1,2`, [sep.id]);
  check(JSON.stringify(matchedBefore) === JSON.stringify(matchedAfter), `los ${matchedBefore.length} matches previos siguen intactos con el mismo statement_line_id`);
  check((await countMatches()) === m0, "NEGATIVO: el runner no creó ningún bank_statement_match");
  check((await countChecks()) === c1, "NEGATIVO: el runner no creó ningún gl_check");
  const sug1 = await readFeedSuggestions({ ids: [splitA, splitB, orphan] });
  const byTx = new Map(sug1.suggestions.map((s) => [s.transaction_id, s]));
  const a = byTx.get(splitA), b = byTx.get(splitB), o = byTx.get(orphan);
  check(a?.kind === "match" && a.stage === "bank_sum" && b?.kind === "match" && b.stage === "bank_sum", "cheque partido: las 2 líneas salen sugeridas 'match' por bank_sum");
  const bookLine = (await q<{ id: string }>(`SELECT l.id FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id JOIN gl_check c ON c.entry_id=e.id WHERE c.id=$1 AND l.account_list_id=$2`, [checkId, wells.qb_list_id]))[0]!;
  check(a?.candidates[0]?.book_id === bookLine.id && b?.candidates[0]?.book_id === bookLine.id && a.candidates[0].amount_cents === partA && b.candidates[0].amount_cents === partB, `ambas apuntan al asiento del cheque con su monto parcial (${partA} + ${partB})`);
  check(/^[a-f0-9]{64}$/.test(a?.candidates[0]?.expected_book_hash ?? ""), "la sugerencia lleva expected_book_hash del asiento");
  check(a?.payee_name === "E2E Split Payee", `payee derivado del documento (${a?.payee_name})`);
  check(o?.kind === "none" && o.payee_name === "MONTHLY SERVICE FEE E2E (sin documento)", "línea sin asiento: kind none, payee = merchant del feed");
  check(a?.stale === false && a.statement_id === sep.id, "sugerencia fresca contra la revisión actual del borrador");
  const run1 = (await q<{ status: string; lines: number; suggested_lines: number; duration_ms: number }>(`SELECT status,lines,suggested_lines,duration_ms FROM bank_suggestion_run WHERE id=$1`, [r1.run_id]))[0]!;
  check(run1.status === "ok" && run1.lines === linesBefore + 3 && run1.suggested_lines >= 2 && run1.duration_ms >= 0, `métricas: lines=${run1.lines} suggested=${run1.suggested_lines} duration=${run1.duration_ms}ms`);

  // 2. Segunda corrida: idempotente.
  const snap = async (): Promise<string> => createHash("sha256").update(JSON.stringify(await q(`SELECT statement_line_id,kind,stage,candidates,alternatives FROM bank_statement_suggestion WHERE statement_id=$1 AND deleted_at IS NULL ORDER BY statement_line_id`, [sep.id]))).digest("hex");
  const s1 = await snap();
  const r2 = await runSuggestionsForMonth(account, "2026-09", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  assert(r2.outcome.status === "ok", `corrida 2: ${JSON.stringify(r2.outcome)}`);
  check(r2.outcome.appended_lines === 0, `corrida 2: 0 líneas nuevas (appended=${r2.outcome.appended_lines})`);
  check((await snap()) === s1, "corrida 2: mismas sugerencias (hash igual)");
  check((await countMatches()) === m0, "corrida 2: 0 matches");
  const revNow = (await q<{ revision: number }>(`SELECT revision FROM bank_statement WHERE id=$1`, [sep.id]))[0]!.revision;
  check(revNow === sep.revision + 1, `el borrador subió UNA revisión (extend real) y la corrida vacía no la movió (${sep.revision}→${revNow})`);

  // 3. Extracto cerrado: no-op registrado.
  const aug = (await q<{ id: string; xmin: string }>(`SELECT id,xmin::text AS xmin FROM bank_statement WHERE bank_account_id=$1 AND from_day='2026-08-01' AND status='closed' AND deleted_at IS NULL`, [wells.id]))[0];
  assert(aug, "Wells agosto está cerrado en el clon");
  const linesAug = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM bank_statement_line WHERE statement_id=$1`, [aug.id]))[0]!.n;
  const r3 = await runSuggestionsForMonth(account, "2026-08", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  const augAfter = (await q<{ xmin: string; n: string }>(`SELECT s.xmin::text AS xmin,(SELECT count(*)::text FROM bank_statement_line l WHERE l.statement_id=s.id) AS n FROM bank_statement s WHERE s.id=$1`, [aug.id]))[0]!;
  check(r3.outcome.status === "skipped" && r3.outcome.skipped_reason === "closed" && augAfter.xmin === aug.xmin && augAfter.n === linesAug, "extracto cerrado: skipped 'closed', fila y líneas intactas (xmin igual)"); // entity-status
  check((await q<{ n: string }>(`SELECT count(*)::text AS n FROM bank_statement_suggestion WHERE statement_id=$1`, [aug.id]))[0]!.n === "0", "sin sugerencias sobre un extracto cerrado");

  console.log(`\n${checks} checks OK (fase 3)`);

  // ── Fase 4 ────────────────────────────────────────────────────────────────────────────────
  const { confirmFeedMatch } = await import("../../lib/banking/feed-confirm-match");
  const { previewFeedDocument, confirmFeedDocument } = await import("../../lib/banking/feed-confirm-document");
  const { confirmTransactionReview, saveTransactionReview } = await import("../../lib/banking/review-core");
  const { bankingTransactions } = await import("../../lib/banking/views");
  const { readDailyReview } = await import("../../lib/banking/review-daily-read");
  const actor = (await q<{ id: string }>(`SELECT id FROM "user" WHERE email='contador@test.com'`))[0]!.id;
  const feedRow = async (id: string): Promise<{ review_status: string; reconciled: { status: string } | null }> => {
    const rows = (await bankingTransactions({ account_id: wells.id, date: dayNew, limit: 200 })).transactions as Array<{ id: string; review_status: string; reconciled: { status: string } | null }>;
    const r = rows.find((x) => x.id === id);
    assert(r, `fila ${id} en el feed`);
    return r;
  };

  // 5. Confirm-match de la parte A.
  const mA = await confirmFeedMatch(splitA, actor, `e2e-${RUN}-a`, { allocations: a!.candidates.map((c) => ({ book_id: c.book_id, amount_cents: c.amount_cents, expected_book_hash: c.expected_book_hash })) });
  check(mA.matched === 1 && mA.suggestions === "refreshed", `Confirm-match A: 1 match, sugerencias recalculadas (rev ${mA.revision})`);
  const rowA = await feedRow(splitA);
  check(rowA.review_status === "reconciled" && rowA.reconciled?.status === "draft", "la fila A del feed sale reconciled · draft statement");
  check((await countMatches()) === m0 + 1, "exactamente UN bank_statement_match nuevo");
  const sugAfter = new Map((await readFeedSuggestions({ ids: [splitA, splitB] })).suggestions.map((s) => [s.transaction_id, s]));
  check(sugAfter.get(splitA)?.kind === "none" && sugAfter.get(splitB)?.kind === "match", "A ya no se sugiere; B sigue sugerida contra el resto del cheque");
  // NEGATIVO: hash de asiento cambiado → drift, sin match.
  let drift = "";
  try { await confirmFeedMatch(splitB, actor, `e2e-${RUN}-bdrift`, { allocations: [{ book_id: bookLine.id, amount_cents: partB, expected_book_hash: "0".repeat(64) }] }); } catch (e) { drift = (e as { code?: string }).code ?? String(e); }
  check(drift === "BANKING_STATEMENT_MATCH_SOURCE_DRIFT" && (await countMatches()) === m0 + 1, `NEGATIVO: expected_book_hash equivocado → ${drift}, sin match`);

  // 6. Ambigua: dos cheques del mismo monto a ±2 días de la línea, referencias distintas.
  const amb = `e2e_sug_${RUN}_amb`, ambCents = 33300 + salt;
  await insertTx(amb, (ambCents / 100).toFixed(2), "AMBIGUOUS VENDOR PAYMENT");
  const cl2 = await pool.connect();
  try {
    for (const day of ["2026-09-10", "2026-09-14"]) {
      const c = await createBankCheck(cl2, { day, bank_account_list_id: wells.qb_list_id, number: null, payee_type: "other", payee_name: `E2E Amb ${day}`, memo: `e2e amb ${RUN}`, to_be_printed: false, lines: [{ account_list_id: expenseAcct, amount_cents: BigInt(ambCents), memo: "amb" }] }, actor);
      await postBankCheck(cl2, c.id, actor);
    }
  } finally { cl2.release(); }
  const r4 = await runSuggestionsForMonth(account, "2026-09", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  assert(r4.outcome.status === "ok", JSON.stringify(r4.outcome));
  const sAmb = (await readFeedSuggestions({ ids: [amb] })).suggestions[0];
  check(sAmb?.kind === "ambiguous" && sAmb.alternatives.length === 2 && (await countMatches()) === m0 + 1, "ambigua: 2 alternativas, ningún match automático");
  const pick = sAmb!.alternatives[1]!;
  const mAmb = await confirmFeedMatch(amb, actor, `e2e-${RUN}-amb`, { allocations: [{ book_id: pick.book_id, amount_cents: pick.amount_cents, expected_book_hash: pick.expected_book_hash }] });
  check(mAmb.matched === 1 && (await feedRow(amb)).review_status === "reconciled", "el contador eligió una alternativa y la confirmó");

  // 7. Confirm-categoría (salida sin documento) con preview.
  const category = expenseAcct;
  const pv = await previewFeedDocument(orphan, { category_list_id: category, payee_type: "other", payee_name: "Bank Fee E2E", number: null, memo: null });
  check(pv.document === "gl_check" && pv.kind === "expense" && pv.qb_txn_type === "Check" && pv.amount_cents === 1500 && pv.lines[0]!.debit_cents === 1500 && pv.lines[1]!.credit_cents === 1500, `preview: ${pv.kind} · ${pv.qb_txn_type} · Dr ${pv.lines[0]!.account} / Cr banco`);
  let stale = "";
  try { await confirmFeedDocument(orphan, actor, `e2e-${RUN}-doc-stale`, { category_list_id: category, payee_type: "other", payee_name: "OTRO NOMBRE", number: null, memo: null, preview_hash: pv.preview_hash }); } catch (e) { stale = (e as { code?: string }).code ?? String(e); }
  check(stale === "BANKING_FEED_PREVIEW_STALE" && (await countChecks()) === c1 + 2, "NEGATIVO: cuerpo distinto al preview → PREVIEW_STALE, sin documento");
  const doc = await confirmFeedDocument(orphan, actor, `e2e-${RUN}-doc`, { category_list_id: category, payee_type: "other", payee_name: "Bank Fee E2E", number: null, memo: null, preview_hash: pv.preview_hash });
  check(doc.document === "gl_check" && /^CHK-\d+$/.test(doc.doc_number) && "statement_id" in doc.match, `Confirm-categoría: ${doc.doc_number} creado, posteado y casado`);
  const glc = (await q<{ status: string; kind: string; entry_id: string }>(`SELECT status,kind,entry_id FROM gl_check WHERE id=$1`, [doc.document_id]))[0]!;
  const pipe = (await q<{ status: string }>(`SELECT status FROM qb_order_pipeline WHERE step='gl_document_add' AND order_id=$1`, [doc.document_id]))[0];
  check(glc.status === "posted" && glc.kind === "expense" && !!glc.entry_id, "gl_check posted con asiento");
  check(pipe?.status === WRITE.sales.dispatchable, `encolado a QuickBooks: gl_document_add ${pipe?.status} (bridge apagado en sandbox -> queda pending)`);
  check((await feedRow(orphan)).review_status === "reconciled", "la línea quedó Matched contra el documento nuevo");
  const again = await confirmFeedDocument(orphan, actor, `e2e-${RUN}-doc`, { category_list_id: category, payee_type: "other", payee_name: "Bank Fee E2E", number: null, memo: null, preview_hash: pv.preview_hash });
  check(again.document_id === doc.document_id && (await countChecks()) === c1 + 3, "misma Idempotency-Key → mismo documento, no se duplica");

  // 8. Entrada con categoría → JE.
  const inflow = `e2e_sug_${RUN}_in`, inCents = 1234 + salt;
  await insertTx(inflow, `-${(inCents / 100).toFixed(2)}`, "INTEREST PAYMENT E2E");
  const incomeAcct = (await q<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type='Income' ORDER BY full_name LIMIT 1`))[0]!.qb_list_id;
  await runSuggestionsForMonth(account, "2026-09", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  const pvIn = await previewFeedDocument(inflow, { category_list_id: incomeAcct, payee_type: "other", payee_name: "Bank Interest", number: null, memo: null });
  check(pvIn.document === "gl_journal_entry" && pvIn.qb_txn_type === "JournalEntry" && pvIn.lines[0]!.debit_cents === inCents, "entrada: preview = JE Dr banco / Cr ingreso, JournalEntryAdd");
  const je = await confirmFeedDocument(inflow, actor, `e2e-${RUN}-je`, { category_list_id: incomeAcct, payee_type: "other", payee_name: "Bank Interest", number: null, memo: null, preview_hash: pvIn.preview_hash });
  const jePipe = (await q<{ status: string }>(`SELECT status FROM qb_order_pipeline WHERE step='gl_document_add' AND order_id=$1`, [je.document_id]))[0];
  check(je.document === "gl_journal_entry" && /^JE-\d+$/.test(je.doc_number) && "statement_id" in je.match && jePipe?.status === WRITE.sales.dispatchable && (await feedRow(inflow)).review_status === "reconciled", `${je.doc_number} creado, encolado y casado`);

  // 9. Confirm viejo sobre una línea de extracto → 409. En un día ABIERTO (el 09/12 del clon está
  //    cerrado y el review viejo ya lo rechaza por eso, que no es lo que se prueba acá).
  const openDay = "2026-09-15";
  const insertOpen = async (id: string, amount: string, name: string, status = "posted"): Promise<void> => {
    await pool.query(
      `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,merchant_name,source_data,first_seen_at,last_seen_at)
       VALUES($1,$2,$3,$1,$4,'USD',$7,$5,$6,$6,'{}',now(),now())`, [id, wells.connection_id, wells.id, amount, openDay, name, status]);
  };
  const pendingTx = `e2e_sug_${RUN}_legacy`;
  await insertOpen(pendingTx, "7.77", "LEGACY CONFIRM E2E");
  await runSuggestionsForMonth(account, "2026-09", { trigger: "manual", actorId: ACTOR, today: "2026-09-15" });
  await saveTransactionReview(pendingTx, actor, `e2e-${RUN}-legacy-save`, { expected_revision: 0, expected_source_version: 1, mode: "categorize", category_list_id: category, comment: "" });
  let legacy = "";
  try { await confirmTransactionReview(pendingTx, actor, `e2e-${RUN}-legacy`, { expected_revision: 1, expected_source_version: 1 }); } catch (e) { legacy = (e as { code?: string }).code ?? String(e); }
  check(legacy === "BANKING_STATEMENT_LINE_CONFIRM_VIA_MATCH", `Confirm viejo sobre línea de extracto → ${legacy}`);

  // 10. Un día con una línea PENDING del banco no cierra.
  const pendingBank = `e2e_sug_${RUN}_pend`;
  await insertOpen(pendingBank, "9.99", "PENDING AT BANK E2E", "pending");
  const day = await readDailyReview(openDay);
  check(!day.can_close && day.blockers.some((b) => /1221/.test(b) && /pending at the bank/.test(b)), `el ${openDay} no cierra: ${day.blockers.find((b) => /pending/.test(b))}`);

  console.log(`\n${checks} checks OK (fases 3+4)`);
  process.stdout.write(JSON.stringify({ splitA, splitB, orphan, checkId, statement: sep.id }) + "\n");
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("e2e-bank-feed-suggestions:", e instanceof Error ? e.message : e); process.exit(1); });
