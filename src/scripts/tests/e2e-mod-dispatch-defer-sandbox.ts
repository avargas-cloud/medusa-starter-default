/**
 * E2E del gate de deferral de MODs (mod-dispatch-gate.ts) — SOLO SANDBOX.
 *
 * El dispatcher NUNCA espera dentro del tick a que otra operación en vuelo
 * sobre el mismo Sales Order confirme: `gateModDispatch` difiere (pending +
 * next_retry_at) la fila más joven cuando hay algo más VIEJO en vuelo, y
 * despacha si no hay nada (o lo en-vuelo es más joven).
 *
 *   1. A (processing, 2min) sin nada en vuelo → despacha.
 *   2. B (processing, nueva) con A 'submitted' → DIFIERE detrás de A, sin PUT.
 *   3. Confirma A (SQL directo, equivalente al poller).
 *   4. Re-claim de B → despacha, ya sin nada en vuelo.
 *   5. Tie-break: C (30s vieja) y D (nueva), resubmiteadas EN PARALELO →
 *      sólo C despacha, D se difiere detrás de C.
 *   6. Cleanup: borra A-D, restaura metadata de la orden y la fila de cache.
 *
 * Bridge mockeado in-process (http.createServer + QB_BRIDGE_URL), nunca toca
 * la red real. Aborta si DATABASE_URL no es el sandbox (:5499). Run con el env
 * del sandbox (back-sb / docker-compose.sandbox.yml, nunca backend/.env):
 *   env DATABASE_URL='postgresql://postgres:<pass>@localhost:5499/medusa' \
 *       REDIS_URL='redis://127.0.0.1:6399' QB_API_KEY='e2e' DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/tests/e2e-mod-dispatch-defer-sandbox.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import * as http from "http";

import { getDbPool } from "../../api/utils/db-pool";
import { resubmitByStep, type ResubmitRow } from "../../lib/quickbooks/consolidator/resubmit-by-step";

const DB = process.env.DATABASE_URL ?? "";
if (!DB.includes(":5499/")) {
  console.error(
    "❌ Refusing to run: DATABASE_URL is not the :5499 sandbox Postgres. " +
      "Never point this script at production."
  );
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: (m: string) => console.error(`    [handler] ${m}`),
};

const E2E_TAG = "mod-dispatch-defer";
const MOCK_BRIDGE_PORT = 58734;

type PutCall = { txnId: string; body: unknown };

/** In-process mock bridge: PUT /api/sales-orders/:txnId pops the next queued
 * operationId; GET /api/sync/status/* answers "pending" (unused here, kept so
 * a stray call never hangs). */
function startMockBridge(state: { opQueue: string[]; putCalls: PutCall[] }): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "PUT" && url.startsWith("/api/sales-orders/")) {
      const txnId = decodeURIComponent(url.slice("/api/sales-orders/".length));
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: unknown = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* not what this test checks */ }
        state.putCalls.push({ txnId, body });
        const operationId = state.opQueue.shift() ?? `e2e-op-unexpected-${state.putCalls.length}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, operationId }));
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/sync/status/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, operation: { status: "pending" } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `mock bridge: unhandled ${req.method} ${url}` }));
  });
  return new Promise((resolve) => server.listen(MOCK_BRIDGE_PORT, () => resolve(server)));
}

type InsertedRow = { id: string; order_id: string; qb_txn_id: string | null; payload: Record<string, unknown> | null };

function toResubmitRow(row: InsertedRow): ResubmitRow {
  return {
    id: row.id,
    order_id: row.order_id,
    reference_id: null,
    reference_type: null,
    step: "sales_order_mod",
    qb_txn_id: row.qb_txn_id,
    retry_count: 0,
    payload: row.payload,
  };
}

export default async function e2eModDispatchDefer({ container }: ExecArgs) {
  const pool = getDbPool();

  // ── 0. Pick target order ────────────────────────────────────────────────
  const { rows: targets } = await pool.query<{ order_id: string; display_id: number; txn_id: string }>(
    `SELECT o.id AS order_id, o.display_id, o.metadata->'qb_sales_order'->>'txn_id' AS txn_id
       FROM "order" o
       JOIN qb_edit_sequence_cache c
         ON c.entity_type = 'sales_order' AND c.qb_id = o.metadata->'qb_sales_order'->>'txn_id'
      WHERE o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL
        AND c.line_ids IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
           WHERE p.order_id = o.id AND p.status IN ('processing', 'submitted', 'pending')
        )
      ORDER BY o.updated_at DESC LIMIT 1`
  );
  if (!targets.length) {
    console.error("❌ No suitable sandbox order found (needs qb_sales_order.txn_id + cache row, no live pipeline rows) — aborting");
    process.exit(1);
  }
  const target = targets[0];
  const orderId = target.order_id;
  const txnId = target.txn_id;
  const medusaRef = `S${target.display_id}`;
  console.log(`\n🎯 Target: ${medusaRef} order=${orderId} txn=${txnId}`);

  // ── Snapshots ────────────────────────────────────────────────────────────
  const { rows: metaSnap } = await pool.query(`SELECT metadata FROM "order" WHERE id = $1`, [orderId]);
  const originalMetadata = metaSnap[0]?.metadata ?? null;

  const { rows: cacheSnap } = await pool.query(
    `SELECT edit_seq, cached_at, line_ids FROM qb_edit_sequence_cache
      WHERE entity_type = 'sales_order' AND qb_id = $1`,
    [txnId]
  );
  const originalCache = cacheSnap[0];
  if (!originalCache) {
    console.error("❌ Cache row vanished between selection and snapshot — aborting");
    process.exit(1);
  }

  const insertedIds: string[] = [];
  const state = { opQueue: [] as string[], putCalls: [] as PutCall[] };
  let server: http.Server | undefined;
  const prevBridgeUrl = process.env.QB_BRIDGE_URL;
  const prevApiKey = process.env.QB_API_KEY;
  if (!process.env.QB_API_KEY) process.env.QB_API_KEY = "e2e-test-key";

  async function insertRow(label: string, createdAtExpr: string): Promise<InsertedRow> {
    const { rows } = await pool.query(
      `INSERT INTO qb_order_pipeline
           (id, order_id, step, status, qb_txn_id, created_at, updated_at, medusa_ref_number, payload)
       VALUES (gen_random_uuid(), $1, 'sales_order_mod', 'processing', $2,
               ${createdAtExpr}, NOW(), $3, $4::jsonb)
       RETURNING id, order_id, qb_txn_id, payload`,
      [orderId, txnId, medusaRef, JSON.stringify({ e2e: E2E_TAG, label })]
    );
    const row = rows[0] as InsertedRow;
    insertedIds.push(row.id);
    return row;
  }

  type FetchedRow = { id: string; status: string; bridge_op_id: string | null; next_retry_at: string | null; error: string | null; confirmed_at: string | null };
  async function fetchRow(id: string): Promise<FetchedRow> {
    const { rows } = await pool.query(
      `SELECT id, status, bridge_op_id, next_retry_at, error, confirmed_at
         FROM qb_order_pipeline WHERE id = $1`,
      [id]
    );
    return rows[0] as FetchedRow;
  }

  try {
    server = await startMockBridge(state);
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${MOCK_BRIDGE_PORT}`;

    // ── Step 1: row A dispatches (nothing else in flight) ──────────────────
    console.log("\n── Step 1: A dispatches, no in-flight sibling");
    const rowA = await insertRow("A", "NOW() - interval '2 minutes'");
    state.opQueue.push("e2e-op-A");
    const t0 = Date.now();
    await resubmitByStep(toResubmitRow(rowA), container, silentLogger);
    const elapsed1 = Date.now() - t0;
    const afterA = await fetchRow(rowA.id);
    check(`elapsed < 15000ms (${elapsed1}ms)`, elapsed1 < 15000);
    check(`A.status === 'submitted'`, afterA.status === "submitted", `got '${afterA.status}'`);
    check(`A.bridge_op_id === 'e2e-op-A'`, afterA.bridge_op_id === "e2e-op-A", `got '${afterA.bridge_op_id}'`);
    check(`mock saw exactly 1 PUT`, state.putCalls.length === 1, `got ${state.putCalls.length}`);

    // ── Step 2: row B defers behind A (still 'submitted' = in flight) ──────
    console.log("\n── Step 2: B defers behind A");
    const rowB = await insertRow("B", "NOW()");
    const putsBefore2 = state.putCalls.length;
    const t1 = Date.now();
    await resubmitByStep(toResubmitRow(rowB), container, silentLogger);
    const elapsed2 = Date.now() - t1;
    const afterB = await fetchRow(rowB.id);
    const { rows: nowRows } = await pool.query(`SELECT NOW() AS now`);
    const nowMs = new Date(nowRows[0].now).getTime();
    const nextRetryMs = afterB.next_retry_at ? new Date(afterB.next_retry_at).getTime() : NaN;
    const deltaSec = (nextRetryMs - nowMs) / 1000;
    check(`elapsed < 5000ms (${elapsed2}ms)`, elapsed2 < 5000);
    check(`B.status === 'pending'`, afterB.status === "pending", `got '${afterB.status}'`);
    check(`B.next_retry_at within [+45s,+75s] (Δ=${deltaSec.toFixed(1)}s)`, deltaSec >= 45 && deltaSec <= 75);
    const bDeferReasonOk = !!afterB.error && afterB.error.includes("deferred") && afterB.error.includes(rowA.id);
    check(`B.error mentions 'deferred' and A.id`, bDeferReasonOk, `error='${afterB.error}'`);
    check(`mock saw NO new PUT (still ${putsBefore2})`, state.putCalls.length === putsBefore2, `got ${state.putCalls.length}`);

    // ── Step 3: confirm A the way the poller would (direct SQL) ────────────
    console.log("\n── Step 3: confirm A (poller-equivalent SQL)");
    await pool.query(`UPDATE qb_order_pipeline SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [rowA.id]);
    const confirmedA = await fetchRow(rowA.id);
    check(`A.status === 'confirmed'`, confirmedA.status === "confirmed");

    // ── Step 4: re-claim B, dispatches now that nothing is in flight ───────
    console.log("\n── Step 4: B re-claimed, dispatches");
    await pool.query(
      `UPDATE qb_order_pipeline SET status = 'processing', next_retry_at = NULL, updated_at = NOW() WHERE id = $1`,
      [rowB.id]
    );
    state.opQueue.push("e2e-op-B");
    const t2 = Date.now();
    await resubmitByStep(toResubmitRow(rowB), container, silentLogger);
    const elapsed4 = Date.now() - t2;
    const afterB2 = await fetchRow(rowB.id);
    check(`elapsed < 15000ms (${elapsed4}ms)`, elapsed4 < 15000);
    check(`B.status === 'submitted'`, afterB2.status === "submitted", `got '${afterB2.status}'`);
    check(`B.bridge_op_id === 'e2e-op-B'`, afterB2.bridge_op_id === "e2e-op-B", `got '${afterB2.bridge_op_id}'`);

    // ── Step 5: tie-break — C (older) wins, D (younger) defers behind C ────
    console.log("\n── Step 5: tie-break C vs D, in parallel");
    await pool.query(`UPDATE qb_order_pipeline SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [rowB.id]);
    const rowC = await insertRow("C", "NOW() - interval '30 seconds'");
    const rowD = await insertRow("D", "NOW()");
    state.opQueue.push("e2e-op-C", "e2e-op-D");
    const putsBefore5 = state.putCalls.length;
    const t3 = Date.now();
    await Promise.all([
      resubmitByStep(toResubmitRow(rowC), container, silentLogger),
      resubmitByStep(toResubmitRow(rowD), container, silentLogger),
    ]);
    const elapsed5 = Date.now() - t3;
    const afterC = await fetchRow(rowC.id);
    const afterD = await fetchRow(rowD.id);
    // The freeze detector. Without MOD_DISPATCH_SERIALIZER_WAIT_MS on the cron
    // path this step measured 300 205 ms (4/4 runs, 2026-09-11): C's serializer
    // caught D still 'processing' for a few ms and waited the default 5 min for
    // a row that had already gone back to 'pending'. The cap makes the worst
    // case ~5 s; the check fails well before the old 5-minute wait.
    check(`elapsed < 15000ms (${elapsed5}ms) — same-tick siblings must not stall the tick`, elapsed5 < 15000);
    check(`C.status === 'submitted'`, afterC.status === "submitted", `got '${afterC.status}'`);
    check(`C.bridge_op_id === 'e2e-op-C'`, afterC.bridge_op_id === "e2e-op-C", `got '${afterC.bridge_op_id}'`);
    check(`D.status === 'pending'`, afterD.status === "pending", `got '${afterD.status}'`);
    check(`D.next_retry_at is set`, !!afterD.next_retry_at);
    check(`D.error mentions C.id`, !!afterD.error && afterD.error.includes(rowC.id), `error='${afterD.error}'`);
    check(`exactly one of C/D submitted, and it's C`, afterC.status === "submitted" && afterD.status !== "submitted");
    const newPuts5 = state.putCalls.length - putsBefore5;
    check(`mock saw exactly 1 new PUT (${newPuts5})`, newPuts5 === 1, `got ${newPuts5}`);
  } finally {
    // ── Step 6: cleanup ──────────────────────────────────────────────────
    console.log("\n── Cleanup");
    if (insertedIds.length) {
      await pool.query(`DELETE FROM qb_order_pipeline WHERE id = ANY($1)`, [insertedIds]);
    }
    await pool.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [orderId, JSON.stringify(originalMetadata)]);
    await pool.query(
      `UPDATE qb_edit_sequence_cache SET edit_seq = $2, cached_at = $3, line_ids = $4::jsonb
        WHERE entity_type = 'sales_order' AND qb_id = $1`,
      [txnId, originalCache.edit_seq, originalCache.cached_at, JSON.stringify(originalCache.line_ids)]
    );

    const { rows: metaAfter } = await pool.query(`SELECT metadata FROM "order" WHERE id = $1`, [orderId]);
    const { rows: cacheAfter } = await pool.query(
      `SELECT edit_seq, line_ids FROM qb_edit_sequence_cache WHERE entity_type = 'sales_order' AND qb_id = $1`,
      [txnId]
    );
    check(`order.metadata restored`, JSON.stringify(metaAfter[0]?.metadata) === JSON.stringify(originalMetadata));
    const cacheOk =
      cacheAfter[0]?.edit_seq === originalCache.edit_seq &&
      JSON.stringify(cacheAfter[0]?.line_ids) === JSON.stringify(originalCache.line_ids);
    check(`qb_edit_sequence_cache row restored`, cacheOk);

    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevBridgeUrl) process.env.QB_BRIDGE_URL = prevBridgeUrl;
    else delete process.env.QB_BRIDGE_URL;
    if (prevApiKey) process.env.QB_API_KEY = prevApiKey;
    else delete process.env.QB_API_KEY;

    console.log(`\n🧹 ${insertedIds.length} filas temporales borradas; metadata + cache restaurados`);
  }

  if (failures > 0) {
    console.error(`\n❌ E2E FAILED — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ E2E PASSED — mod-dispatch-gate defer/dispatch/tie-break");
}
