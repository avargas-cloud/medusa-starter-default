/**
 * convert-qb-pipeline-status-vocab — rewrites every legacy pipeline status to
 * the canonical vocabulary of `lib/quickbooks/pipeline-status.ts`
 * (plan qb-pipeline-status-vocab-20260917). Runs AFTER the EXPAND build is
 * ACTIVE (its code reads both vocabularies) and BEFORE the CONTRACT build.
 *
 *   DRY-RUN (default): counts per table/literal, checks the UNIQUE-index
 *   preconditions, writes the report to .qb-docs-cache/pipeline-vocab/.
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL=postgresql://…:5499/medusa_chk \
 *     ./node_modules/.bin/tsx src/scripts/fix/convert-qb-pipeline-status-vocab.ts [--apply | --reverse]
 *
 *   --apply    one transaction PER TABLE (never a long lock across all nine);
 *              idempotent — re-running converts only stragglers written by the
 *              old build during the cutover. Production needs
 *              --target-production + CONFIRM_PRODUCTION_RUN=<run id> + the
 *              dry-run report (target-guard).
 *   --reverse  inverse map, for a rollback of the EXPAND build. Sales `error`
 *              → `failed` keeps its next_retry_at (that IS the legacy meaning).
 *
 * What it converts (and what it deliberately does NOT):
 *   sales      waiting→blocked · confirmed→synced · failed+next_retry_at→error
 *              NOT pending→waiting: the expand build still WRITES `pending`
 *              (legacy `waiting` meant blocked, so `waiting` cannot become
 *              dispatchable until every legacy row is gone). The contract
 *              build's consolidator sweeps `pending` → `waiting`.
 *   purchases  status failed_permanent→failed · cancelled→skipped
 *              mod_status completed→synced · failed_permanent→failed
 *              void_status voided→synced
 *   log        completed→synced
 *   Rows in `processing` / `submitted` are never touched (a worker owns them).
 *   `updated_at` is never moved (row triggers bypassed per transaction).
 *
 * Precondition it enforces before writing: turning a sales `failed`+retry row
 * into `error` makes it LIVE for the partial UNIQUE indexes
 * (`uq_qb_pipeline_write_check_live`, `uq_qb_pipeline_sales_receipt_live`
 * exclude only failed/skipped). If two such rows would collide, it aborts and
 * lists them — a human decides which one is the real attempt.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { VOCAB_PHASE } from "../../lib/quickbooks/pipeline-status";
import {
  assertDryRunEvidence,
  latestFile,
  readJsonFile,
  resolveWriteTarget,
} from "../../lib/qb-backfill/target-guard";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const REVERSE = argv.includes("--reverse");
const RUN_ID = "convert_qb_pipeline_status_vocab";
const CACHE_DIR = join(process.cwd(), ".qb-docs-cache", "pipeline-vocab");
const REPORT_RE = /^convert_qb_pipeline_status_vocab_dry-run_.*\.json$/;
const log = (line: string): void => process.stdout.write(`${line}\n`);

type Step = { table: string; col: string; from: string; to: string; extra?: string };

const FORWARD: Step[] = [
  // Only while the code is in its EXPAND phase: after CONTRACT the sales
  // literal `waiting` IS the canonical dispatchable and must not be touched.
  ...(VOCAB_PHASE === "expand"
    ? [{ table: "qb_order_pipeline", col: "status", from: "waiting", to: "blocked" }]
    : []),
  { table: "qb_order_pipeline", col: "status", from: "confirmed", to: "synced" },
  { table: "qb_order_pipeline", col: "status", from: "failed", to: "error", extra: "next_retry_at IS NOT NULL" },
  ...["qb_purchase_order_pipeline", "qb_item_receipt_pipeline", "qb_vendor_bill_pipeline", "qb_item_pipeline", "qb_vendor_pipeline", "qb_inventory_adjustment_pipeline"].flatMap((t) => [
    { table: t, col: "status", from: "failed_permanent", to: "failed" },
    { table: t, col: "status", from: "cancelled", to: "skipped" },
  ]),
  { table: "qb_item_receipt_pipeline", col: "mod_status", from: "completed", to: "synced" },
  { table: "qb_item_receipt_pipeline", col: "mod_status", from: "failed_permanent", to: "failed" },
  { table: "qb_purchase_order_pipeline", col: "void_status", from: "voided", to: "synced" },
  { table: "qb_item_receipt_pipeline", col: "void_status", from: "voided", to: "synced" },
  { table: "qb_sync_log", col: "status", from: "completed", to: "synced" },
];

const REVERSE_STEPS: Step[] = [
  ...(VOCAB_PHASE === "expand"
    ? [{ table: "qb_order_pipeline", col: "status", from: "blocked", to: "waiting" }]
    : []),
  { table: "qb_order_pipeline", col: "status", from: "synced", to: "confirmed" },
  { table: "qb_order_pipeline", col: "status", from: "error", to: "failed" },
  ...["qb_purchase_order_pipeline", "qb_item_receipt_pipeline", "qb_vendor_bill_pipeline", "qb_item_pipeline", "qb_vendor_pipeline", "qb_inventory_adjustment_pipeline"].flatMap((t) => [
    { table: t, col: "status", from: "failed", to: "failed_permanent" },
    { table: t, col: "status", from: "skipped", to: "cancelled" },
  ]),
  { table: "qb_item_receipt_pipeline", col: "mod_status", from: "synced", to: "completed" },
  { table: "qb_item_receipt_pipeline", col: "mod_status", from: "failed", to: "failed_permanent" },
  { table: "qb_purchase_order_pipeline", col: "void_status", from: "synced", to: "voided" },
  { table: "qb_item_receipt_pipeline", col: "void_status", from: "synced", to: "voided" },
  { table: "qb_sync_log", col: "status", from: "synced", to: "completed" },
];

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
  return r.rows[0]?.ok === true;
}

async function columnExists(client: PoolClient, table: string, col: string): Promise<boolean> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
    [table, col]
  );
  return r.rows[0]?.n !== "0";
}

function where(step: Step): string {
  const base = `"${step.col}" = '${step.from}'`;
  return step.extra ? `${base} AND ${step.extra}` : base;
}

async function census(client: PoolClient, steps: Step[]): Promise<Array<Step & { count: number }>> {
  const out: Array<Step & { count: number }> = [];
  for (const s of steps) {
    if (!(await tableExists(client, s.table)) || !(await columnExists(client, s.table, s.col))) continue;
    const r = await client.query<{ n: string }>(`SELECT count(*)::text n FROM "${s.table}" WHERE ${where(s)}`);
    out.push({ ...s, count: Number(r.rows[0]?.n ?? 0) });
  }
  return out;
}

/** Sales rows that would collide on a partial UNIQUE index once `failed`+retry becomes `error`. */
async function uniqueCollisions(client: PoolClient): Promise<string[]> {
  const q = async (sql: string) => (await client.query<{ k: string }>(sql)).rows.map((r) => r.k);
  const wc = await q(`
    SELECT reference_id || ' (write_check)' k FROM qb_order_pipeline
     WHERE step = 'write_check' AND reference_id IS NOT NULL
       AND (status NOT IN ('failed','skipped') OR (status = 'failed' AND next_retry_at IS NOT NULL))
     GROUP BY reference_id HAVING count(*) > 1`);
  const sr = await q(`
    SELECT order_id || '/' || COALESCE(reference_id,'') || ' (sales_receipt)' k FROM qb_order_pipeline
     WHERE step = 'sales_receipt'
       AND (status NOT IN ('failed','skipped') OR (status = 'failed' AND next_retry_at IS NOT NULL))
     GROUP BY order_id, reference_id HAVING count(*) > 1`);
  return [...wc, ...sr];
}

async function main(): Promise<void> {
  if (APPLY && REVERSE) throw new Error("--apply y --reverse son excluyentes");
  const steps = REVERSE ? REVERSE_STEPS : FORWARD;
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    const plan = await census(client, steps);
    const nonZero = plan.filter((p) => p.count > 0);
    log(`${REVERSE ? "REVERSE" : "FORWARD"} — filas a convertir por tabla/literal:`);
    for (const p of plan) log(`  ${p.count.toString().padStart(6)}  ${p.table}.${p.col}  ${p.from} → ${p.to}${p.extra ? `  [${p.extra}]` : ""}`);
    const total = nonZero.reduce((a, p) => a + p.count, 0);
    log(`  total: ${total}`);

    const busy = await client.query<{ t: string; n: string }>(`
      SELECT 'qb_order_pipeline' t, count(*)::text n FROM qb_order_pipeline WHERE status IN ('processing','submitted')
      UNION ALL SELECT 'qb_purchase_order_pipeline', count(*)::text FROM qb_purchase_order_pipeline WHERE status IN ('processing','submitted')
      UNION ALL SELECT 'qb_item_receipt_pipeline', count(*)::text FROM qb_item_receipt_pipeline WHERE status IN ('processing','submitted')`);
    log(`  en vuelo (no se tocan): ${busy.rows.map((r) => `${r.t}=${r.n}`).join(" · ")}`);

    const collisions = REVERSE ? [] : await uniqueCollisions(client);
    if (collisions.length) {
      log(`\n❌ ${collisions.length} colisión(es) de índice único si failed+retry pasa a error:`);
      for (const c of collisions) log(`   - ${c}`);
      log("   Resolver a mano (skip de la fila duplicada) antes de aplicar.");
      process.exitCode = 2;
      return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const cardinality: Record<string, number> = Object.fromEntries(
      nonZero.map((p) => [`${p.table}.${p.col}.${p.from}→${p.to}`, p.count])
    );
    if (!APPLY && !REVERSE) {
      const path = join(CACHE_DIR, `${RUN_ID}_dry-run_${stamp}.json`);
      writeFileSync(path, JSON.stringify({ run_id: RUN_ID, cardinality, total }, null, 2));
      log(`\nDRY-RUN: no se escribió nada. Reporte: ${path}\nUsá --apply (sandbox) o --apply --target-production + CONFIRM_PRODUCTION_RUN=${RUN_ID} (prod).`);
      return;
    }

    const target = resolveWriteTarget({ argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    if (APPLY) {
      const evidencePath = latestFile(CACHE_DIR, REPORT_RE);
      const evidence = evidencePath ? readJsonFile<{ cardinality: Record<string, number> }>(evidencePath) : null;
      assertDryRunEvidence(target.target, RUN_ID, evidence ? { path: evidencePath!, cardinality: evidence.cardinality } : null, log);
    }
    log(`destino: ${target.target} (${target.dbTarget}) · ${REVERSE ? "revirtiendo" : "convirtiendo"} ${total} filas, una transacción por tabla`);

    const applied: Record<string, number> = {};
    const tables = [...new Set(nonZero.map((p) => p.table))];
    for (const table of tables) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        // `qb_order_pipeline` has a BEFORE UPDATE trigger that stamps
        // updated_at = NOW() on ANY update. A rename must not move that clock:
        // `findConfirmedAddTxnId` picks the TxnID by `ORDER BY updated_at DESC`
        // and 503 (order, step) pairs have more than one synced row — the
        // first prod run (09/17) stamped 18,350 rows to the same microsecond
        // and had to be restored from confirmed_at. Bypass row triggers for
        // this transaction only (superuser; no FK is touched by a status rename).
        await client.query(`SET LOCAL session_replication_role = replica`);
        for (const s of nonZero.filter((p) => p.table === table)) {
          const r = await client.query(
            `UPDATE "${table}" SET "${s.col}" = '${s.to}' WHERE ${where(s)}`
          );
          applied[`${table}.${s.col}.${s.from}→${s.to}`] = r.rowCount ?? 0;
          log(`  ${String(r.rowCount ?? 0).padStart(6)}  ${table}.${s.col}  ${s.from} → ${s.to}`);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    const residue = await census(client, steps);
    const left = residue.reduce((a, p) => a + p.count, 0);
    const path = join(CACHE_DIR, `${RUN_ID}_${REVERSE ? "reverse" : "apply"}_${stamp}.json`);
    writeFileSync(path, JSON.stringify({ run_id: RUN_ID, target: target.target, applied, residue: left }, null, 2));
    log(`\n${left === 0 ? "✅" : "⚠️"} residuo con literal viejo: ${left}. Reporte: ${path}`);
    if (left) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
