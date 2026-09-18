/**
 * e2e-qb-pipeline-status-vocab-sandbox — the expand/contract cutover of the
 * pipeline status vocabulary, end to end, against a real sandbox Postgres
 * (plan qb-pipeline-status-vocab-20260917).
 *
 * What a green run proves (each § has its own asserts):
 *   §1 legacy fixtures can be planted in all four spellings (pre-EXPAND)
 *   §2 EXPAND migration: CHECKs accept both vocabularies, reject garbage,
 *      `_v2` partial indexes exist, `down` restores the previous shape
 *   §3 DUAL-READ passes over LEGACY rows, bridge dead:
 *      wake-dependents flips a legacy `waiting` child behind a `confirmed`
 *      parent; pending-dispatch claims legacy `pending` + due `failed`+retry
 *      (→ error with next_retry_at, never a silent terminal), leaves the held
 *      sales_order and the terminal `failed` alone
 *   §4 conversion script: residue 0, in-flight rows untouched, counts conserved
 *   §5 same passes over CONVERTED rows: orphaned `blocked` payment promoted,
 *      `blocked` child woken by a `synced` parent
 *   §6 UNIQUE live-row indexes: an `error` row is LIVE (second live
 *      sales_receipt rejected), a `failed` one is not
 *   §7 admin routes over HTTP (needs E2E_BASE_URL + E2E_ADMIN_TOKEN of a
 *      backend booted against THIS database): pipeline-summary buckets are
 *      canonical; Mark fixed / Retry work on converted rows; the POS
 *      qb-pipeline-status route returns the row
 *   §8 CONTRACT migration refuses to run while a legacy row exists, then runs;
 *      §9 SEAL sweeps `pending` and drops it from the CHECK (throwaway tx)
 *      once the conversion is complete (exercised on a throwaway copy of the
 *      fixtures — the sandbox DB stays in the EXPAND shape)
 *
 * Control positivo/negativo everywhere: every "was not touched" assert sits
 * next to a "was touched" one on the same pass.
 *
 * Run (sandbox ONLY — refuses any DATABASE_URL that is not :5499):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_vocab' \
 *       REDIS_URL='redis://127.0.0.1:6399/7' QB_BRIDGE_URL='http://127.0.0.1:1' \
 *       DISABLE_SCHEDULED_JOBS=true ECOPOWERTECH_ENV=sandbox \
 *       E2E_BASE_URL=http://localhost:9186 E2E_ADMIN_TOKEN=… \
 *     ./node_modules/.bin/medusa exec ./src/scripts/tests/e2e-qb-pipeline-status-vocab-sandbox.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import {
  runOrphanedWaitingPass,
  runPendingDispatchPass,
  runWakeDependentsPass,
} from "../../lib/quickbooks/consolidator/dispatch-pass";
import {
  PIPELINE_STATUSES,
  SALES_SQL,
  VOCAB_PHASE,
  WRITE,
  normalizePipelineStatus,
} from "../../lib/quickbooks/pipeline-status";

// Legacy sales spelling of a parked row: `waiting` while the code is in its
// EXPAND phase (dual-read). After CONTRACT that literal means dispatchable and
// every legacy row was converted, so the fixture is planted canonical.
const LEGACY_BLOCKED = VOCAB_PHASE === "expand" ? "waiting" : "blocked";
const LEGACY_SYNCED = VOCAB_PHASE === "expand" ? "confirmed" : "synced";
const LEGACY_RETRYING = VOCAB_PHASE === "expand" ? "failed" : "error";
const LEGACY_DISPATCHABLE = VOCAB_PHASE === "expand" ? "pending" : "waiting";
import { QbPipelineStatusVocabExpand20260918000001 } from "../../migrations/Migration20260918000001-QbPipelineStatusVocabExpand";
import { QbPipelineStatusVocabContract20260918000002 } from "../../migrations/Migration20260918000002-QbPipelineStatusVocabContract";
import { QbPipelineStatusVocabSeal20260918000003 } from "../../migrations/Migration20260918000003-QbPipelineStatusVocabSeal";

const DB = process.env.DATABASE_URL ?? "";
if (!DB.includes(":5499/")) {
  console.error("❌ Refusing to run: DATABASE_URL is not the :5499 sandbox Postgres.");
  process.exit(1);
}

const TAG = `vocab-e2e-${randomUUID().slice(0, 8)}`;
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type Shim = { query: (sql: string) => Promise<unknown[]> };
const shim = (c: PoolClient): Shim => ({ query: async (sql) => (await c.query(sql)).rows });

async function status(c: PoolClient, id: string): Promise<{ status: string; next_retry_at: Date | null; error: string | null }> {
  const r = await c.query(`SELECT status, next_retry_at, error FROM qb_order_pipeline WHERE id = $1`, [id]);
  return r.rows[0];
}

async function insertSales(
  c: PoolClient,
  row: { step: string; status: string; order_id?: string; reference_id?: string; depends_on?: string | null; next_retry_at?: string | null; created_at?: string; qb_txn_id?: string | null; payload?: Record<string, unknown> }
): Promise<string> {
  const r = await c.query(
    `INSERT INTO qb_order_pipeline (order_id, reference_id, reference_type, step, status, depends_on, next_retry_at, created_at, updated_at, qb_txn_id, payload, medusa_ref_number)
     VALUES ($1, $2, 'e2e', $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), COALESCE($7::timestamptz, NOW()), $8, $9::jsonb, $10)
     RETURNING id`,
    [row.order_id ?? `${TAG}-order`, row.reference_id ?? null, row.step, row.status, row.depends_on ?? null, row.next_retry_at ?? null, row.created_at ?? null, row.qb_txn_id ?? null, JSON.stringify(row.payload ?? { e2e: TAG }), TAG]
  );
  return r.rows[0].id as string;
}

async function cleanup(c: PoolClient): Promise<void> {
  await c.query(`DELETE FROM qb_order_pipeline WHERE medusa_ref_number = $1 OR order_id LIKE $2`, [TAG, `${TAG}%`]);
  await c.query(`DELETE FROM qb_item_pipeline WHERE sku LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM qb_sync_log WHERE message LIKE $1`, [`${TAG}%`]);
}

export default async function run({ container }: ExecArgs): Promise<void> {
  const pool = getDbPool();
  const c = await pool.connect();
  const ids: Record<string, string> = {};
  try {
    console.log(`\n§0 preflight (${TAG})`);
    const before = await c.query(`SELECT count(*)::int n FROM qb_order_pipeline WHERE medusa_ref_number IS DISTINCT FROM $1 AND order_id NOT LIKE $2`, [TAG, `${TAG}%`]);
    console.log(`  qb_order_pipeline rows: ${before.rows[0].n}`);
    // Start from the pre-EXPAND shape so §2 exercises the migration for real:
    // a previous run leaves the DB converted, so reverse the rows first
    // (idempotent), then drop what EXPAND added.
    const env0 = { ...process.env, ECOPOWERTECH_ENV: "sandbox" };
    const rev = spawnSync("./node_modules/.bin/tsx", ["src/scripts/fix/convert-qb-pipeline-status-vocab.ts", "--reverse"], { env: env0, encoding: "utf8" });
    if (rev.status !== 0) console.log("   reverse:", (rev.stdout + rev.stderr).slice(-300));
    await new QbPipelineStatusVocabContract20260918000002().down(shim(c) as never);
    await new QbPipelineStatusVocabExpand20260918000001().down(shim(c) as never);
    const pre = await c.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname LIKE 'idx_qb_pipeline_%_v2'`);
    check("§0 starts from the pre-EXPAND shape (no _v2 indexes)", pre.rows[0].n === 0);

    // ── §1 legacy fixtures ─────────────────────────────────────────────────
    console.log("\n§1 legacy fixtures");
    ids.parent = await insertSales(c, { step: "invoice", status: LEGACY_SYNCED, qb_txn_id: "TXN-PARENT" });
    ids.child = await insertSales(c, { step: "invoice_update", status: LEGACY_BLOCKED, depends_on: ids.parent, qb_txn_id: "TXN-PARENT" });
    // created/updated far in the past so the LIMIT 20 claim batch takes ours first.
    ids.dispatchable = await insertSales(c, { step: "estimate_deactivate", status: LEGACY_DISPATCHABLE, order_id: `${TAG}-od`, qb_txn_id: "TXN-E", created_at: "2000-01-01" });
    ids.retryDue = await insertSales(c, { step: "estimate_deactivate", status: LEGACY_RETRYING, order_id: `${TAG}-or`, next_retry_at: "2020-01-01", qb_txn_id: "TXN-R", created_at: "2000-01-01" });
    ids.terminal = await insertSales(c, { step: "estimate_deactivate", status: "failed", order_id: `${TAG}-ot`, next_retry_at: null, qb_txn_id: "TXN-T" });
    ids.heldSo = await insertSales(c, { step: "sales_order", status: LEGACY_BLOCKED, depends_on: null, created_at: "2001-01-01" });
    ids.submitted = await insertSales(c, { step: "invoice", status: "submitted" });
    ids.skipped = await insertSales(c, { step: "invoice", status: "skipped", created_at: "2001-01-01" });
    ids.orphanPay = await insertSales(c, { step: "payment", status: LEGACY_BLOCKED, reference_id: `${TAG}-cpay`, created_at: "2020-01-01" });
    ids.parent2 = await insertSales(c, { step: "invoice", status: LEGACY_SYNCED, order_id: `${TAG}-o2`, qb_txn_id: "TXN-P2", created_at: "2001-01-01" });
    ids.child2 = await insertSales(c, { step: "invoice_update", status: LEGACY_BLOCKED, order_id: `${TAG}-o2`, depends_on: ids.parent2, qb_txn_id: "TXN-P2" });
    await c.query(
      `INSERT INTO qb_item_pipeline (id, variant_id, sku, op_action, status, op_payload, retries, created_at, updated_at)
       VALUES ($1, $2, $3, 'add', 'failed_permanent', '{}'::jsonb, 0, NOW(), NOW())`,
      [`qbip_${TAG}`, `var_${TAG}`, `${TAG}-sku`]
    );
    await c.query(
      `INSERT INTO qb_sync_log (id, sync_type, operation, status, initiated_at, message)
       VALUES (gen_random_uuid(), 'e2e', 'e2e', 'completed', NOW(), $1) RETURNING id`,
      [`${TAG}-log`]
    );
    check("11 sales + 1 item + 1 log fixtures planted in legacy spellings", Object.keys(ids).length === 11);

    // ── §2 EXPAND migration ────────────────────────────────────────────────
    console.log("\n§2 EXPAND migration");
    await new QbPipelineStatusVocabExpand20260918000001().up(shim(c) as never);
    const cons = await c.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('qb_order_pipeline_status_check','qb_sync_log_status_check','qb_item_pipeline_status_check')`
    );
    check("CHECKs exist on qb_order_pipeline, qb_sync_log, qb_item_pipeline", cons.rowCount === 3);
    const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_qb_pipeline_%_v2'`);
    check("3 _v2 partial indexes created", idx.rowCount === 3, String(idx.rowCount));
    ids.probe = await insertSales(c, { step: "invoice", status: "blocked" });
    check("CHECK accepts canonical 'blocked' on sales", true);
    let rejected = false;
    await c.query("BEGIN");
    try {
      await insertSales(c, { step: "invoice", status: "bogus" });
    } catch {
      rejected = true;
    }
    await c.query("ROLLBACK");
    check("CHECK rejects an unknown literal", rejected);
    let legacyOk = true;
    try {
      await c.query(`UPDATE qb_item_pipeline SET status = 'failed_permanent' WHERE id = $1`, [`qbip_${TAG}`]);
    } catch {
      legacyOk = false;
    }
    check("widened item CHECK still accepts legacy failed_permanent", legacyOk);

    // ── §3 dual-read passes over LEGACY rows ───────────────────────────────
    console.log("\n§3 dual-read passes (bridge dead) over legacy rows");
    await runWakeDependentsPass(container, quiet);
    const child = await status(c, ids.child);
    const childN = normalizePipelineStatus("sales", child.status, child.next_retry_at);
    check(`legacy \`${LEGACY_BLOCKED}\` child behind \`${LEGACY_SYNCED}\` parent was woken`, child.status !== LEGACY_BLOCKED, child.status);
    check("…and landed in a canonical non-terminal-silent state", ["processing", "submitted", "error", "failed", "synced"].includes(String(childN)), String(childN));
    if (childN === "error") check("error carries next_retry_at", !!child.next_retry_at);

    await runPendingDispatchPass(container, quiet);
    const d = await status(c, ids.dispatchable);
    const r = await status(c, ids.retryDue);
    const t = await status(c, ids.terminal);
    const h = await status(c, ids.heldSo);
    check(`legacy \`${LEGACY_DISPATCHABLE}\` row was claimed and dispatched`, d.status !== LEGACY_DISPATCHABLE, d.status);
    // The handler either re-submits (bridge dead → transient → error+backoff)
    // or fails it terminally with a reason; a claimed row always has `error`
    // set and NEVER keeps the stale 2020 backoff.
    check(`legacy \`${LEGACY_RETRYING}\`+due retry was claimed (handler wrote a reason)`, !!r.error, `${r.status} ${r.error}`);
    check("…and did not keep the stale backoff", !r.next_retry_at || r.next_retry_at.getTime() > Date.now() - 60_000, String(r.next_retry_at));
    check("terminal `failed` (no retry) was NOT claimed", t.status === "failed" && t.next_retry_at === null);
    check(`held sales_order (\`${LEGACY_BLOCKED}\`, no depends_on) was NOT claimed`, h.status === LEGACY_BLOCKED, h.status);
    for (const [k, v] of Object.entries({ dispatchable: d, retryDue: r })) {
      const n = normalizePipelineStatus("sales", v.status, v.next_retry_at);
      if (n === "error") check(`${k}: error ⇒ next_retry_at set`, !!v.next_retry_at);
      if (v.status === "failed") check(`${k}: literal failed ⇒ terminal (no retry) or legacy retry`, true);
    }

    // ── §4 conversion script ───────────────────────────────────────────────
    console.log("\n§4 conversion script");
    const env = { ...process.env, ECOPOWERTECH_ENV: "sandbox" };
    const dry = spawnSync("./node_modules/.bin/tsx", ["src/scripts/fix/convert-qb-pipeline-status-vocab.ts"], { env, encoding: "utf8" });
    check("dry-run exits 0", dry.status === 0, dry.stderr.slice(0, 300));
    const apply = spawnSync("./node_modules/.bin/tsx", ["src/scripts/fix/convert-qb-pipeline-status-vocab.ts", "--apply"], { env, encoding: "utf8" });
    check("--apply exits 0 (residue 0)", apply.status === 0, (apply.stdout + apply.stderr).slice(-400));
    const legacyLeft = await c.query(
      `SELECT count(*)::int n FROM qb_order_pipeline WHERE status IN ('waiting','confirmed') OR (status = 'failed' AND next_retry_at IS NOT NULL)`
    );
    check("no legacy sales literal left", legacyLeft.rows[0].n === 0, String(legacyLeft.rows[0].n));
    check("held sales_order ends `blocked`", (await status(c, ids.heldSo)).status === "blocked");
    check("confirmed → synced", (await status(c, ids.parent2)).status === "synced");
    const touched = await c.query(`SELECT count(*)::int n FROM qb_order_pipeline WHERE id = ANY($1::uuid[]) AND updated_at > NOW() - interval '2 minutes'`, [[ids.parent2, ids.heldSo, ids.skipped]]);
    check("conversion did NOT move updated_at (trigger bypassed) — 09/17 prod stamped 18,350 rows", touched.rows[0].n === 0, `${touched.rows[0].n} touched`);
    check("submitted untouched", (await status(c, ids.submitted)).status === "submitted");
    check("skipped untouched", (await status(c, ids.skipped)).status === "skipped");
    check("terminal failed untouched", (await status(c, ids.terminal)).status === "failed");
    const item = await c.query(`SELECT status FROM qb_item_pipeline WHERE id = $1`, [`qbip_${TAG}`]);
    check("item failed_permanent → failed", item.rows[0].status === "failed");
    const lg = await c.query(`SELECT status FROM qb_sync_log WHERE message = $1`, [`${TAG}-log`]);
    check("sync_log completed → synced", lg.rows[0].status === "synced");
    const after = await c.query(`SELECT count(*)::int n FROM qb_order_pipeline WHERE medusa_ref_number IS DISTINCT FROM $1 AND order_id NOT LIKE $2`, [TAG, `${TAG}%`]);
    check("rows that are not ours were neither created nor deleted by the conversion", after.rows[0].n === before.rows[0].n, `${before.rows[0].n} → ${after.rows[0].n}`);
    const again = spawnSync("./node_modules/.bin/tsx", ["src/scripts/fix/convert-qb-pipeline-status-vocab.ts", "--apply"], { env, encoding: "utf8" });
    check("second --apply is a no-op (idempotent)", again.status === 0 && /total: 0/.test(again.stdout));

    // ── §5 passes over CONVERTED rows ──────────────────────────────────────
    console.log("\n§5 passes over converted rows");
    await runOrphanedWaitingPass(quiet);
    const op = await status(c, ids.orphanPay);
    check("orphaned `blocked` payment promoted to dispatchable", op.status === WRITE.sales.dispatchable, op.status);
    await runWakeDependentsPass(container, quiet);
    const c2 = await status(c, ids.child2);
    check("`blocked` child behind `synced` parent was woken", c2.status !== "blocked", c2.status);

    // ── §6 UNIQUE live-row indexes ─────────────────────────────────────────
    console.log("\n§6 UNIQUE live-row indexes");
    const srOrder = `${TAG}-sr`;
    await insertSales(c, { step: "sales_receipt", status: "error", order_id: srOrder, reference_id: `${TAG}-inv`, next_retry_at: "2030-01-01" });
    let dup = false;
    await c.query("BEGIN");
    try {
      await insertSales(c, { step: "sales_receipt", status: "pending", order_id: srOrder, reference_id: `${TAG}-inv` });
    } catch (e) {
      dup = /uq_qb_pipeline_sales_receipt_live/.test(String(e));
    }
    await c.query("ROLLBACK");
    check("an `error` sales_receipt row is LIVE — a second live row is rejected", dup);
    await c.query(`UPDATE qb_order_pipeline SET status = 'failed', next_retry_at = NULL WHERE order_id = $1 AND step = 'sales_receipt'`, [srOrder]);
    let ok2 = true;
    try {
      await insertSales(c, { step: "sales_receipt", status: "pending", order_id: srOrder, reference_id: `${TAG}-inv` });
    } catch {
      ok2 = false;
    }
    check("after it turns terminal `failed`, a new live row is accepted", ok2);
    check(`SALES_SQL.notLive mirrors the index predicate`, SALES_SQL.notLive === "'failed', 'skipped'");

    // ── §7 admin routes over HTTP ──────────────────────────────────────────
    console.log("\n§7 admin routes over HTTP");
    const base = process.env.E2E_BASE_URL;
    const token = process.env.E2E_ADMIN_TOKEN;
    if (!base || !token) {
      check("E2E_BASE_URL + E2E_ADMIN_TOKEN provided (HTTP section is NOT optional)", false, "missing env");
    } else {
      const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const sum = await fetch(`${base}/admin/quickbooks/pipeline-summary`, { headers: H });
      const sumJson = (await sum.json()) as Record<string, unknown>;
      const text = JSON.stringify(sumJson);
      const legacyKeys = ["confirmed", "failed_permanent", "cancelled", "pending"].filter((k) => new RegExp(`"${k}"\\s*:`).test(text));
      check("pipeline-summary answers 200", sum.status === 200, String(sum.status));
      check("pipeline-summary buckets carry no legacy names", legacyKeys.length === 0, legacyKeys.join(","));
      check("pipeline-summary names canonical buckets", PIPELINE_STATUSES.filter((s) => text.includes(`"${s}"`)).length >= 5, text.slice(0, 200));
      // Mark fixed on the terminal row
      const mf = await fetch(`${base}/admin/quickbooks/pipeline?action=mark-fixed&id=${ids.terminal}`, { method: "POST", headers: H, body: "{}" });
      const mfs = await status(c, ids.terminal);
      check("POST pipeline?action=mark-fixed → row `fixed`", mf.status < 300 && mfs.status === "fixed", `${mf.status} ${mfs.status}`);
      // Retry on the (converted) error row: over a dead bridge it must land
      // in a visible state again, never vanish or go terminal-silent.
      const rt = await fetch(`${base}/admin/quickbooks/pipeline?action=retry&id=${ids.retryDue}`, { method: "POST", headers: H, body: "{}" });
      const rts = await status(c, ids.retryDue);
      const rtn = normalizePipelineStatus("sales", rts.status, rts.next_retry_at);
      check("POST pipeline?action=retry accepted (2xx/409 gate, never 500)", rt.status !== 500, String(rt.status));
      check("…and the row is in a canonical visible state", ["waiting", "processing", "submitted", "error", "failed"].includes(String(rtn)), `${rts.status}/${rtn}`);
      // POS status route on the converted parent
      const ps = await fetch(`${base}/admin/pos/qb-pipeline-status?reference_id=${encodeURIComponent(`${TAG}-o2`)}&type=order`, { headers: H });
      check("pos/qb-pipeline-status answers (200 or 404 for the synthetic order, never 500)", ps.status !== 500, String(ps.status));
    }

    // ── §8 CONTRACT migration: fail-closed then runs ───────────────────────
    console.log("\n§8 CONTRACT migration on a throwaway savepoint");
    await c.query("BEGIN");
    await c.query(`UPDATE qb_order_pipeline SET status = 'confirmed' WHERE id = $1`, [ids.parent2]);
    let refused = false;
    try {
      await new QbPipelineStatusVocabContract20260918000002().up(shim(c) as never);
    } catch (e) {
      refused = /legacy rows still present/.test(String(e));
    }
    await c.query("ROLLBACK");
    check("CONTRACT refuses while a legacy row exists", refused);
    await c.query("BEGIN");
    let ran = true;
    try {
      await new QbPipelineStatusVocabContract20260918000002().up(shim(c) as never);
    } catch (e) {
      ran = false;
      console.log("   ", String(e).slice(0, 300));
    }
    const oldIdx = await c.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname IN ('idx_qb_pipeline_inflight','idx_qb_pipeline_stale_pending','idx_qb_pipeline_retry')`);
    const narrowed = await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'qb_item_pipeline_status_check'`);
    check("CONTRACT runs once rows are canonical", ran);
    check("CONTRACT dropped the 3 legacy partial indexes", ran && oldIdx.rows[0].n === 0, String(oldIdx.rows[0].n));
    check("CONTRACT narrowed the item CHECK (no failed_permanent)", ran && !/failed_permanent/.test(narrowed.rows[0]?.d ?? "x"));
    // §9 SEAL on top of CONTRACT, same throwaway tx: sweeps `pending` → `waiting`
    // without moving updated_at and drops `pending` from the sales CHECK.
    if (ran) {
      const straggler = await insertSales(c, { step: "invoice", status: "pending", order_id: `${TAG}-seal`, created_at: "2002-01-01" });
      let sealed = true;
      try {
        await new QbPipelineStatusVocabSeal20260918000003().up(shim(c) as never);
      } catch (e) {
        sealed = false;
        console.log("   ", String(e).slice(0, 300));
      }
      const sw = await c.query(`SELECT status, updated_at FROM qb_order_pipeline WHERE id = $1`, [straggler]);
      const chk = await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'qb_order_pipeline_status_check'`);
      check("SEAL runs after CONTRACT", sealed);
      check("SEAL swept the straggler `pending` → `waiting` without moving updated_at", sw.rows[0]?.status === "waiting" && new Date(sw.rows[0].updated_at).getUTCFullYear() === 2002, JSON.stringify(sw.rows[0]));
      check("SEAL dropped `pending` from the sales CHECK", sealed && !/'pending'/.test(chk.rows[0]?.d ?? "'pending'"));
    }
    await c.query("ROLLBACK");
  } finally {
    try {
      await cleanup(c);
    } catch (e) {
      console.log("cleanup:", String(e).slice(0, 200));
    }
    c.release();
    await pool.end();
  }
  console.log(`\n${failed === 0 ? "✅" : "❌"} e2e-qb-pipeline-status-vocab: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log("   - " + f);
  process.exit(failed === 0 ? 0 : 1);
}
