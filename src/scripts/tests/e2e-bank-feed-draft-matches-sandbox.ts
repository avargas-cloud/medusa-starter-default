/**
 * e2e-bank-feed-draft-matches-sandbox.ts — plan feed-draft-matches-daily-close-20260915:
 * una línea del feed casada en un extracto en BORRADOR se muestra `reconciled` (status 'draft')
 * con sus asientos, cuenta como revisada para el Daily Close, y el script `close-review-days`
 * cierra un día real en orden. Contra un clon DESECHABLE de una copia de prod
 * (`CREATE DATABASE medusa_sep3 TEMPLATE medusa_cutover2` + migraciones); usa la Wells 1221 y la
 * Regions 1416 REALES del clon (enero casado 16/16 y 90/90 en borrador; feed de Wells hasta el 09/09).
 *
 *   ECOPOWERTECH_ENV=sandbox GL_POSTING_ENABLED=true QB_SYNC_ENABLED=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_sep3' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-feed-draft-matches-sandbox.ts
 *
 * Fixture (sandbox): las conexiones del clon están `disconnected` y sincronizadas hace >26 h →
 * se marcan activas y sincronizadas ahora (el Daily Close las bloquea si no).
 *
 * Qué prueba:
 *   1. Wells 09/01→09/09 en borrador (reconcile --apply) con una salida SINTÉTICA sin documento:
 *      las 6 líneas reales salen `review_status='reconciled'`, `reconciled.status='draft'`, con
 *      `matches` (la del 09/08 con 8); la sintética queda `pending` y `reconciled=null`.
 *   2. Daily read: el 09/08 Wells tiene 0 pendientes; el día de la sintética tiene 1.
 *   3. `close-review-days` 01/13→01/14: 01/13 bloqueado (la Visa 2084 del clon está seleccionada SIN
 *      setup y tiene líneas ese día); 01/14 (Wells 1 + Regions 2, casadas en el borrador de enero) se
 *      cierra; `bank_day_close` lo tiene `closed`; el feed lo sigue mostrando `reconciled`. Las cuentas
 *      no seleccionadas y las seleccionadas sin setup y sin líneas ese día ya no bloquean.
 *      NEGATIVOS: --apply frena en el primer bloqueado; un día cerrado se saltea.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { getDbPool } from "../../api/utils/db-pool";
import { readDailyReview } from "../../lib/banking/review-daily-read";
import { requireBankingSandbox } from "../../lib/banking/security";
import { bankingTransactions } from "../../lib/banking/views";

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
  const wells = (await pool.query<{ id: string; connection_id: string }>(
    `SELECT id,connection_id FROM bank_account WHERE mask='1221' AND type='depository' AND is_selected AND deleted_at IS NULL`)).rows[0];
  assert(wells, "Wells 1221 existe en el clon");
  // Fixture: conexiones vivas y frescas (el clon viene disconnected y viejo).
  await pool.query(`UPDATE bank_connection SET status='active', last_successful_sync_at=now() WHERE deleted_at IS NULL`);
  const RUN = Date.now().toString(36);
  const orphanId = `e2e_draftm_${RUN}_fee`;
  await pool.query(
    `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
     VALUES($1,$2,$3,$1,15.00,'USD','posted','2026-09-05','MONTHLY SERVICE FEE E2E (sin documento)','{}',now(),now())`, [orphanId, wells.connection_id, wells.id]);

  console.log("1. borrador de Wells 09/01→09/09 y proyección del feed");
  const rec = run("src/scripts/ledger/reconcile-feed-statement.ts", ["--mask", "1221", "--from", "2026-09-01", "--to", "2026-09-09", "--apply", "--reset"]);
  check(rec.code === 0 && /banco-sin-libro 1 /.test(rec.out), `reconcile --apply: 1 línea sin libro (la sintética)`);
  const page = await bankingTransactions({ account_id: wells.id, offset: 0, limit: 50, date_from: "2026-09-01", date_to: "2026-09-09", history: true });
  const real = page.transactions.filter((t) => t.id !== orphanId && t.status === "posted");
  const orphan = page.transactions.find((t) => t.id === orphanId);
  check(real.length === 6 && real.every((t) => t.review_status === "reconciled" && t.reconciled?.status === "draft"), "las 6 líneas reales: review_status reconciled · reconciled.status draft");
  const withMatches = real.filter((t) => ((t.reconciled as { matches?: unknown[] } | null)?.matches?.length ?? 0) > 0);
  const eight = real.find((t) => t.amount === "10663.54");
  check(withMatches.length === 6 && ((eight?.reconciled as { matches?: unknown[] } | null)?.matches?.length ?? 0) === 8, "todas traen matches; la del 09/08 trae los 8 asientos del cheque partido");
  check(!!orphan && orphan.review_status === "pending" && orphan.reconciled === null, "la línea del borrador SIN match sigue pending (reconciled null)");
  const byFilter = await bankingTransactions({ account_id: wells.id, offset: 0, limit: 50, date_from: "2026-09-01", date_to: "2026-09-09", review_status: "reconciled", history: true });
  check(byFilter.count === 6, `el filtro review_status=reconciled devuelve las 6 (${byFilter.count})`);

  console.log("2. Daily read cuenta las casadas como revisadas");
  const d0908 = await readDailyReview("2026-09-08");
  const wellsBlock = d0908.accounts.find((a) => a.account.id === wells.id);
  check(!!wellsBlock && wellsBlock.pending_count === 0 && wellsBlock.transactions.length >= 1, "09/08: Wells 0 pendientes (1 línea casada en borrador)");
  const d0905 = await readDailyReview("2026-09-05");
  check((d0905.accounts.find((a) => a.account.id === wells.id)?.pending_count ?? -1) === 1, "09/05: Wells 1 pendiente (la sintética sin match)");

  console.log("3. close-review-days cierra días reales");
  // 01/13: Chase (extracto cerrado) + Regions (borrador casado) + la Visa 2084 del clon, seleccionada
  // SIN setup y con líneas ese día → bloqueado por "Set the start date". 01/14: Wells 1 + Regions 2,
  // todas casadas en los borradores de enero → listo. Las cuentas NO seleccionadas (5748, 9621…) y las
  // seleccionadas sin setup y sin líneas ese día ya no bloquean.
  const dry = run("src/scripts/banking/close-review-days.ts", ["--from", "2026-01-13", "--to", "2026-01-14"]);
  check(dry.code === 0 && /2026-01-13  BLOQUEADO.*Set the start date/.test(dry.out) && /2026-01-14  listo/.test(dry.out) && /DRY-RUN/.test(dry.out),
    "dry-run: 01/13 bloqueado (2084 seleccionada sin setup, con líneas) · 01/14 listo");
  check(!/9621|5748/.test(dry.out), "las cuentas no seleccionadas ya no aparecen como bloqueo");
  const apply = run("src/scripts/banking/close-review-days.ts", ["--from", "2026-01-14", "--to", "2026-01-14", "--apply"]);
  check(apply.code === 0 && /2026-01-14  CERRADO/.test(apply.out) && /cerrados ahora 1/.test(apply.out), "--apply cerró el 01/14");
  const closed = (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_day_close WHERE status='closed' AND day='2026-01-14'`)).rows[0]!;
  check(Number(closed.n) === 1, "bank_day_close: 01/14 closed");
  const jan14 = await bankingTransactions({ account_id: wells.id, offset: 0, limit: 10, date_from: "2026-01-14", date_to: "2026-01-14", history: true });
  check(jan14.transactions.length === 1 && jan14.transactions.every((t) => t.day_closed && t.review_status === "reconciled"), "01/14: day_closed y el feed sigue diciendo reconciled (gana sobre closed)");
  const again = run("src/scripts/banking/close-review-days.ts", ["--from", "2026-01-13", "--to", "2026-01-14", "--apply"]);
  check(again.code === 0 && /se frena en el primer día bloqueado/.test(again.out) && /cerrados ahora 0/.test(again.out), "NEGATIVO: --apply frena en el 01/13 bloqueado y no cierra nada");
  const again2 = run("src/scripts/banking/close-review-days.ts", ["--from", "2026-01-14", "--to", "2026-01-14", "--apply"]);
  check(again2.code === 0 && /ya cerrados 1/.test(again2.out), "NEGATIVO: un día cerrado se saltea (ya cerrados 1)");
  console.log(`\nPASS ${checks} checks`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
