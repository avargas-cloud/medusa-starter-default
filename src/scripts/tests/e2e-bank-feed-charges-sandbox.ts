/**
 * e2e-bank-feed-charges-sandbox.ts — los dos cambios de scripts del plan sep-feed-reconcile
 * (2026-09-15), corridos como los corre el operador (los scripts reales, por `tsx`) contra una DB
 * sandbox DESECHABLE (clon de una copia de prod: `CREATE DATABASE medusa_sep TEMPLATE medusa_cutover2`
 * + migraciones). Usa la Wells 1221 REAL del clon: feed hasta el 09/09 y el cheque de QB
 * `Check 30737561593` del 09/08 partido en 8 líneas contra Wells.
 *
 *   ECOPOWERTECH_ENV=sandbox GL_POSTING_ENABLED=true QB_SYNC_ENABLED=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_sep' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-feed-charges-sandbox.ts
 *
 * Qué prueba:
 *   1. `bulk-card-charges` sobre una cuenta BANK (depository), ventana 09/01→09/08: una salida
 *      SINTÉTICA del feed ("MONTHLY SERVICE FEE" $15 el 09/05, insertada por este E2E con prefijo
 *      propio — las reales de esa ventana ya están todas en el libro y se saltean) → un `gl_check`
 *      kind `expense`, posteado, memo `feed:<id>`, crédito a Wells, y su fila `gl_document_add`
 *      (CheckAdd). El crédito del feed (Instant Pmt) NO entra. Re-correr → "a cargar 0" (idempotente
 *      por memo). NEGATIVO: ventana hasta el 09/09 con la misma regla → el wire a Veetech queda
 *      "sin regla" → aborta y no escribe nada.
 *   2. `reconcile-feed-statement` sobre Wells: la línea del 09/08 (+$10.663,54) casa contra las
 *      8 líneas del MISMO documento por el neteo genérico (una etapa "mismo documento" dedicada se
 *      probó por mutación el 2026-09-15 y no cambiaba nada: se retiró), y la expense nueva casa 1:1.
 *      Y `--reset` reescribe el borrador aunque cambie `to` (un mes en curso se abre hasta hoy y se
 *      cierra el mes después); sin `--reset`, un borrador solapado aborta.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDbPool } from "../../api/utils/db-pool";
import { requireBankingSandbox } from "../../lib/banking/security";

const TSX = "./node_modules/.bin/tsx";
let checks = 0;
const check = (ok: boolean, label: string): void => { assert(ok, label); checks++; console.log(`  ✓ ${label}`); };
const run = (script: string, args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync(TSX, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
};

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  const wells = (await pool.query<{ id: string; qb_list_id: string }>(
    `SELECT id,qb_list_id FROM bank_account WHERE mask='1221' AND type='depository' AND is_selected AND deleted_at IS NULL`)).rows[0];
  assert(wells, "Wells 1221 existe en el clon");
  // Fixture con sufijo por corrida (el clon acumula y se descarta): una salida del feed sin asiento.
  const RUN = Date.now().toString(36);
  const conn = (await pool.query<{ connection_id: string }>(`SELECT connection_id FROM bank_account WHERE id=$1`, [wells.id])).rows[0]!;
  const feeId = `e2e_feedchg_${RUN}_fee`;
  await pool.query(
    `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
     VALUES($1,$2,$3,$1,15.00,'USD','posted','2026-09-05','MONTHLY SERVICE FEE E2E','{}',now(),now())`, [feeId, conn.connection_id, wells.id]);
  const fees = [{ id: feeId, day: "2026-09-05" }];
  const feesAcct = (await pool.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE full_name='Bank Service Charges:Fees' AND is_active`)).rows[0];
  assert(feesAcct, "cuenta Bank Service Charges:Fees");
  const dir = mkdtempSync(join(tmpdir(), "e2e-feed-charges-"));
  const rules = join(dir, "rules.json");
  const bulk = "src/scripts/ledger/bulk-card-charges.ts";
  const sept = ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-08"];
  const wide = ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-09"];

  console.log("1. bulk-card-charges sobre una cuenta Bank");
  // Negativo primero: hasta el 09/09 entra el wire a Veetech, que la regla no cubre → aborta y no escribe.
  writeFileSync(rules, JSON.stringify({ _accounts: { FEES: feesAcct.qb_list_id }, rules: [["FEES", "monthly service fee"]] }));
  const before = Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM gl_check WHERE bank_account_list_id=$1`, [wells.qb_list_id])).rows[0]!.n);
  const neg = run(bulk, [...wide, "--rules", rules, "--apply"]);
  check(neg.code !== 0 && /sin regla/.test(neg.out), "NEGATIVO: salidas sin regla → aborta");
  const afterNeg = Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM gl_check WHERE bank_account_list_id=$1`, [wells.qb_list_id])).rows[0]!.n);
  check(afterNeg === before, "NEGATIVO: no escribió ningún gl_check");
  // Positivo: hasta el 09/08 la única salida sin asiento es el fee.
  const dry = run(bulk, [...sept, "--rules", rules]);
  check(dry.code === 0 && /banco → expense/.test(dry.out) && /DRY-RUN/.test(dry.out), "dry-run: reconoce la cuenta como banco → expense y no escribe");
  const apply = run(bulk, [...sept, "--rules", rules, "--apply"]);
  check(apply.code === 0 && /posteados \d+ · fallaron 0/.test(apply.out), `--apply posteó sin fallos (${/posteados \d+ · fallaron \d+/.exec(apply.out)?.[0]})`);
  const docs = (await pool.query<{ id: string; kind: string; memo: string; status: string; doc_number: string }>(
    `SELECT id,kind,memo,status,doc_number FROM gl_check WHERE bank_account_list_id=$1 AND memo = ANY($2::text[])`, [wells.qb_list_id, fees.map((f) => `feed:${f.id}`)])).rows;
  check(docs.length === 1 && docs.every((d) => d.kind === "expense" && d.status === "posted"), "la salida sintética es un gl_check kind expense, posted, memo feed:<id>");
  const journal = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.account_list_id=$1 AND l.credit_cents=1500
      WHERE e.source_kind='bank_check' AND e.kind='document' AND e.source_id = ANY($2::text[])`, [wells.qb_list_id, docs.map((d) => d.id)])).rows[0]!;
  check(Number(journal.n) === 1, "acredita $15 a Wells en el libro");
  const pipeline = (await pool.query<{ n: string; types: string }>(
    `SELECT count(*)::text AS n, string_agg(DISTINCT payload->>'qb_txn_type', ',') AS types FROM qb_order_pipeline
      WHERE step='gl_document_add' AND reference_type='gl_check' AND reference_id = ANY($1::text[])`, [docs.map((d) => d.id)])).rows[0]!;
  check(Number(pipeline.n) === 1 && pipeline.types === "Check", "tiene su fila gl_document_add con qb_txn_type Check (CheckAdd, no CreditCardCharge)");
  const again = run(bulk, [...sept, "--rules", rules, "--apply"]);
  check(again.code === 0 && /a cargar 0 /.test(again.out), "re-correr: a cargar 0 (idempotente por memo)");
  check(/créditos del feed \(no entran\) 1 /.test(again.out), "el crédito del feed (Instant Pmt) queda afuera y se reporta");

  console.log("2. reconcile-feed-statement: cheque partido en 8 líneas (Wells 09/08) + reset por from");
  const rec = "src/scripts/ledger/reconcile-feed-statement.ts";
  // `to` ≤ hoy (BANKING_STATEMENT_DATE_INVALID si no) y el feed del clon termina el 09/09.
  const first = run(rec, ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-09", "--apply"]);
  check(first.code === 0, `reconcile --apply corrió (${first.code})\n${first.code ? first.out.slice(-800) : ""}`);
  const line = (await pool.query<{ id: string; n: string; entries: string }>(
    `SELECT sl.id, count(m.id)::text AS n, string_agg(DISTINCT e.document_number, ',') AS entries
       FROM bank_statement_line sl JOIN bank_statement s ON s.id=sl.statement_id AND s.deleted_at IS NULL
       LEFT JOIN bank_statement_match m ON m.statement_line_id=sl.id AND m.deleted_at IS NULL
       LEFT JOIN bank_journal_line l ON l.id=m.book_id LEFT JOIN bank_journal_entry e ON e.id=l.entry_id
      WHERE s.bank_account_id=$1 AND sl.deleted_at IS NULL AND sl.amount_cents=1066354 GROUP BY sl.id`, [wells.id])).rows[0];
  check(!!line && Number(line.n) === 8 && line.entries === "Check 30737561593", `la línea +$10.663,54 casó contra las 8 líneas de Check 30737561593 (${line?.n ?? 0} matches: ${line?.entries ?? "-"})`);
  const feesMatched = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM bank_statement_match m JOIN bank_journal_line l ON l.id=m.book_id JOIN bank_journal_entry e ON e.id=l.entry_id
      WHERE m.deleted_at IS NULL AND e.source_kind='bank_check' AND e.source_id = ANY($1::text[])`, [docs.map((d) => d.id)])).rows[0]!;
  check(Number(feesMatched.n) === 1, "la expense nueva casó 1:1 con su línea del feed");
  const overlap = run(rec, ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-08", "--apply"]);
  check(overlap.code !== 0 && /usá --reset/.test(overlap.out), "NEGATIVO: otro `to` sobre el mismo `from` sin --reset → aborta");
  const rewrite = run(rec, ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-08", "--apply", "--reset"]);
  const draft = (await pool.query<{ n: string; to_day: string }>(
    `SELECT count(*)::text AS n, max(to_day)::text AS to_day FROM bank_statement WHERE bank_account_id=$1 AND from_day='2026-09-01' AND deleted_at IS NULL`, [wells.id])).rows[0]!;
  check(rewrite.code === 0 && /pasa de \.\.2026-09-09 a \.\.2026-09-08/.test(rewrite.out) && Number(draft.n) === 1 && draft.to_day === "2026-09-08",
    `--reset reescribe el MISMO borrador con el nuevo to (${draft.n} borrador, hasta ${draft.to_day})`);
  console.log(`\nPASS ${checks} checks`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
