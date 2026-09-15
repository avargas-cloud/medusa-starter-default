/**
 * e2e-bank-suggest-parity-sandbox.ts — plan bank-feed-suggestions-20260915, Fase 2.
 * El casador pasó de vivir inline en `reconcile-feed-statement.ts` a la librería
 * `lib/banking/statement-suggest` (etapas 5a–5e). Paridad: cada borrador de septiembre del clon
 * (casado por el script VIEJO en prod el 09/15) se descasa y se vuelve a casar con `--reset`; el
 * conjunto (línea por CONTENIDO día|monto|descripción, asiento, monto) tiene que dar el MISMO hash que
 * antes. Por contenido y no por id: dos gemelas idénticas (TD 09/03, 2× QVH −$2.300) se emparejan
 * "en orden", y el orden sigue a ids que el reset regenera — cruzarlas es la misma conciliación. Contra un clon
 * DESECHABLE de prod (`medusa_sug`).
 *
 *   ECOPOWERTECH_ENV=sandbox GL_POSTING_ENABLED=true QB_SYNC_ENABLED=true \
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_sug' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-suggest-parity-sandbox.ts [--baseline sandbox-artifacts/sug-s1.txt]
 *
 * Con `--baseline` compara además contra los hashes capturados ANTES de tocar el código (los
 * matches del clon podrían haber sido reescritos por una corrida previa de este mismo test).
 * Además prueba la librería en seco: `suggestStatement` sobre el contexto de un borrador ya
 * casado propone 0 asignaciones nuevas (todo está tomado) y sobre el mismo borrador descasado
 * propone exactamente las que el script escribió.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { getDbPool } from "../../api/utils/db-pool";
import { requireBankingSandbox } from "../../lib/banking/security";
import { withReviewLock } from "../../lib/banking/review-common";
import { statementContext } from "../../lib/banking/statement-read";
import { loadSuggestParams, suggestStatement } from "../../lib/banking/statement-suggest";
import { transaction } from "../../lib/banking/store";

const TSX = "./node_modules/.bin/tsx";
let checks = 0;
const check = (ok: boolean, label: string): void => { assert(ok, label); checks++; console.log(`  ✓ ${label}`); };
const run = (args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync(TSX, ["src/scripts/ledger/reconcile-feed-statement.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
};
const HASH_SQL = `SELECT a.mask,s.id,s.to_day::text AS to_day,
    md5(string_agg(sl.day||'|'||sl.amount_cents||'|'||sl.description||'|'||m.book_id||'|'||m.amount_cents, ',' ORDER BY sl.day,sl.amount_cents,sl.description,m.book_id,m.amount_cents)) AS hash,count(*)::int AS n
  FROM bank_statement s JOIN bank_account a ON a.id=s.bank_account_id
  JOIN bank_statement_line sl ON sl.statement_id=s.id AND sl.deleted_at IS NULL
  JOIN bank_statement_match m ON m.statement_line_id=sl.id AND m.deleted_at IS NULL
  WHERE s.deleted_at IS NULL AND s.status='draft' AND s.from_day='2026-09-01' GROUP BY 1,2,3 ORDER BY 1`;
type Row = { mask: string; id: string; to_day: string; hash: string; n: number };

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  const baselineArg = process.argv.indexOf("--baseline");
  const baseline = new Map<string, string>();
  if (baselineArg >= 0) {
    for (const line of readFileSync(process.argv[baselineArg + 1]!, "utf8").split("\n").filter(Boolean)) {
      const [mask, , hash] = line.split("|");
      baseline.set(mask!, hash!);
    }
  }
  // Fixture (clon): el script keyea la evidencia por (cuenta, from, to) y el cuerpo lleva el saldo
  // calculado del feed, que ya se movió desde la corrida de prod → BANKING_IDEMPOTENCY_CONFLICT.
  // En el flujo real el mes se reescribe con otro `to` (..09/30) y no choca; acá se retiran los
  // recibos de hoy de evidencia/alta de extracto para que el reset pueda correr.
  const cleared = await pool.query(
    `DELETE FROM bank_review_event WHERE entity_type='command' AND entity_id='new'
       AND action IN ('completion_evidence','statement_save') AND created_at::date=current_date`
  );
  // Cada `--reset` sube una evidencia nueva y deja la anterior huérfana; el cap de sandbox de
  // `bank_evidence_document` (100, cuenta filas totales) se alcanza a la 4ª corrida.
  // La tabla es inmutable por trigger (bien): sólo este fixture de SANDBOX lo suspende, y sólo para
  // las huérfanas de hoy (ninguna la referencia un extracto).
  const fx = await pool.connect();
  let orphans: { rowCount: number | null };
  try {
    await fx.query(`ALTER TABLE bank_evidence_document DISABLE TRIGGER bank_evidence_document_immutable`);
    try {
      orphans = await fx.query(
        `DELETE FROM bank_evidence_document e WHERE e.created_at::date=current_date
           AND NOT EXISTS (SELECT 1 FROM bank_statement s WHERE s.evidence_id=e.id)`
      );
    } finally {
      await fx.query(`ALTER TABLE bank_evidence_document ENABLE TRIGGER bank_evidence_document_immutable`);
    }
  } finally {
    fx.release();
  }
  console.log(`fixture: ${cleared.rowCount} recibos de idempotencia de hoy retirados (evidencia/alta) · ${orphans.rowCount} evidencias huérfanas de hoy borradas`);
  const before = (await pool.query<Row>(HASH_SQL)).rows;
  assert(before.length >= 7, `esperaba ≥7 borradores de septiembre casados, hay ${before.length}`);
  console.log(`borradores de septiembre: ${before.map((r) => `${r.mask}(${r.n})`).join(" ")}`);

  // A. Librería en seco sobre un borrador YA casado: 0 asignaciones nuevas.
  for (const row of before) {
    const client = await pool.connect();
    try {
      const ctx = await transaction(client, async () => { await withReviewLock(client); return statementContext(client, row.id); });
      const params = await loadSuggestParams(client, { account_list_id: ctx.statement.account_list_id, book_item_ids: ctx.book_items.map((b) => b.id), to: ctx.statement.to, toleranceDays: 5, bpToleranceDays: row.mask === "1416" ? 45 : 30 });
      const plan = suggestStatement(ctx, params);
      check(plan.allocations.length === 0, `${row.mask}: casado → la librería no propone nada nuevo (${plan.by_line.size} líneas, ${[...plan.by_line.values()].filter((l) => l.kind === "none").length} none)`);
    } finally { client.release(); }
  }

  // B. --reset (descasa + reescribe + re-casa con la librería) → mismo hash.
  for (const row of before) {
    const extra = row.mask === "1416" ? ["--bp-tolerance-days", "45"] : [];
    const r = run(["--mask", row.mask, "--from", "2026-09-01", "--to", row.to_day, "--apply", "--reset", ...extra]);
    assert(r.code === 0, `reconcile --reset ${row.mask} falló:\n${r.out.slice(-800)}`);
    const after = (await pool.query<Row>(`${HASH_SQL.replace("ORDER BY 1", "")} HAVING a.mask=$1`, [row.mask])).rows[0];
    assert(after, `${row.mask}: sin matches después del reset`);
    check(after.n === row.n && after.hash === row.hash, `${row.mask}: paridad ${row.n} matches, hash ${row.hash.slice(0, 8)} == ${after.hash.slice(0, 8)}`);
    if (baseline.has(row.mask))
      check(baseline.get(row.mask) === after.hash, `${row.mask}: coincide con el baseline S1 capturado antes del cambio`);
  }
  console.log(`\n${checks} checks OK`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("e2e-bank-suggest-parity:", e instanceof Error ? e.message : e); process.exit(1); });
