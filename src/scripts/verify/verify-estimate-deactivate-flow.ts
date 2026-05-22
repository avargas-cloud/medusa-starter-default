/**
 * verify-estimate-deactivate-flow.ts
 *
 * Sandbox verification for the two QB-pipeline fixes:
 *   BUG 1 — promoteStaleWaitingSalesOrders: rescue 'waiting' Sales Order rows
 *           orphaned past the 24h qb-pos-sync ceiling.
 *   BUG 2 — enqueueEstimateDeactivateIfNeeded + estimate_deactivate step:
 *           close the source Estimate (IsActive=false) once its SO confirms.
 *
 * RUN (sandbox ONLY — never prod):
 *   DATABASE_URL=postgresql://postgres:sandbox@127.0.0.1:5499/medusa \
 *   QB_DRY_RUN=true \
 *   node_modules/.bin/ts-node --transpile-only \
 *     src/scripts/verify/verify-estimate-deactivate-flow.ts
 *
 * QB_DRY_RUN=true makes deactivateEstimateInQb succeed without contacting the
 * bridge (disabled in sandbox), so the estimate_deactivate resubmit path can be
 * exercised end-to-end at the DB level.
 *
 * All fixtures use the 'test_deact_' order-id prefix and are cleaned up before
 * and after the run, so no real rows are touched.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { promoteStaleWaitingSalesOrders } from "../../lib/quickbooks/pipeline/promote-stale-sales-orders";
import { enqueueEstimateDeactivateIfNeeded } from "../../lib/quickbooks/pipeline/enqueue-estimate-deactivate";
import { resubmitByStep } from "../../lib/quickbooks/consolidator/resubmit-by-step";
import * as fs from "fs";
import * as path from "path";

const PREFIX = "test_deact_";
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof getDbPool>;

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`,
    [`${PREFIX}%`]
  );
  await pool.query(`DELETE FROM "order" WHERE id LIKE $1`, [`${PREFIX}%`]);
}

async function seedOrder(
  pool: Pool,
  id: string,
  opts: { canceled?: boolean } = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO "order" (id, currency_code, is_draft_order, created_at, updated_at, canceled_at)
     VALUES ($1, 'usd', false, NOW(), NOW(), $2)`,
    [id, opts.canceled ? new Date() : null]
  );
}

async function seedRow(
  pool: Pool,
  o: {
    orderId: string;
    step: string;
    status: string;
    dependsOn?: string | null;
    ageHours?: number;
    qbTxnId?: string | null;
  }
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO qb_order_pipeline
       (order_id, step, status, depends_on, qb_txn_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' hours')::interval, NOW())
     RETURNING id`,
    [
      o.orderId,
      o.step,
      o.status,
      o.dependsOn ?? null,
      o.qbTxnId ?? null,
      String(o.ageHours ?? 0),
    ]
  );
  return rows[0].id as string;
}

async function statusOf(pool: Pool, orderId: string, step: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT status FROM qb_order_pipeline WHERE order_id = $1 AND step = $2 LIMIT 1`,
    [orderId, step]
  );
  return rows[0]?.status ?? null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes(":5499/")) {
    throw new Error(
      `Refusing to run: DATABASE_URL must point to the sandbox (:5499). Got: ${process.env.DATABASE_URL?.slice(0, 40)}`
    );
  }
  const pool = getDbPool();
  await cleanup(pool);

  // ─────────────────────────────────────────────────────────────────────────
  // BUG 1 — promoteStaleWaitingSalesOrders
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nBUG 1 — rescue orphaned 'waiting' Sales Orders");

  for (const id of ["A1", "A2", "A3", "A4", "A5", "A6"]) {
    await seedOrder(pool, `${PREFIX}${id}`, { canceled: id === "A4" });
  }
  // A1: eligible (age 2h, depends_on NULL, no invoice, active order)
  await seedRow(pool, { orderId: `${PREFIX}A1`, step: "sales_order", status: "waiting", ageHours: 2 });
  // A2: too young (age 10min) → use 0.1h
  await seedRow(pool, { orderId: `${PREFIX}A2`, step: "sales_order", status: "waiting", ageHours: 0.1 });
  // A3: has depends_on → owned by wake pass (depends_on FK → a real parent row)
  const a3Parent = await seedRow(pool, { orderId: `${PREFIX}A3`, step: "customer", status: "confirmed", ageHours: 3 });
  await seedRow(pool, { orderId: `${PREFIX}A3`, step: "sales_order", status: "waiting", ageHours: 2, dependsOn: a3Parent });
  // A4: order canceled
  await seedRow(pool, { orderId: `${PREFIX}A4`, step: "sales_order", status: "waiting", ageHours: 2 });
  // A5: active invoice exists → blocked
  await seedRow(pool, { orderId: `${PREFIX}A5`, step: "sales_order", status: "waiting", ageHours: 2 });
  await seedRow(pool, { orderId: `${PREFIX}A5`, step: "invoice", status: "pending", ageHours: 2 });
  // A6: only a FAILED invoice → not blocked → eligible
  await seedRow(pool, { orderId: `${PREFIX}A6`, step: "sales_order", status: "waiting", ageHours: 2 });
  await seedRow(pool, { orderId: `${PREFIX}A6`, step: "invoice", status: "failed", ageHours: 2 });

  const rescued = await promoteStaleWaitingSalesOrders(pool);
  const rescuedOrders = new Set(rescued.map((r) => r.order_id));

  check("A1 promoted to pending", (await statusOf(pool, `${PREFIX}A1`, "sales_order")) === "pending");
  check("A1 in returned rows", rescuedOrders.has(`${PREFIX}A1`));
  check("A2 stays waiting (age < 1h)", (await statusOf(pool, `${PREFIX}A2`, "sales_order")) === "waiting");
  check("A3 stays waiting (has depends_on)", (await statusOf(pool, `${PREFIX}A3`, "sales_order")) === "waiting");
  check("A4 stays waiting (order canceled)", (await statusOf(pool, `${PREFIX}A4`, "sales_order")) === "waiting");
  check("A5 stays waiting (active invoice blocks)", (await statusOf(pool, `${PREFIX}A5`, "sales_order")) === "waiting");
  check("A6 promoted (failed invoice does not block)", (await statusOf(pool, `${PREFIX}A6`, "sales_order")) === "pending");
  check("only A1 + A6 returned", rescued.length === 2 && rescuedOrders.has(`${PREFIX}A6`));

  // ─────────────────────────────────────────────────────────────────────────
  // BUG 2 — enqueueEstimateDeactivateIfNeeded + estimate_deactivate step
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nBUG 2 — close source Estimate after SO confirms");

  // B-order with a confirmed estimate carrying a qb_txn_id
  await seedOrder(pool, `${PREFIX}B`);
  await seedRow(pool, { orderId: `${PREFIX}B`, step: "estimate", status: "confirmed", qbTxnId: "TEST-EST-TXN-123" });

  const b1 = await enqueueEstimateDeactivateIfNeeded(`${PREFIX}B`);
  check("B1 returns a row id", !!b1);
  check("B1 estimate_deactivate row is pending", (await statusOf(pool, `${PREFIX}B`, "estimate_deactivate")) === "pending");
  const { rows: b1rows } = await pool.query(
    `SELECT qb_txn_id FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate_deactivate'`,
    [`${PREFIX}B`]
  );
  check("B1 row carries the estimate qb_txn_id", b1rows.length === 1 && b1rows[0].qb_txn_id === "TEST-EST-TXN-123");

  // B2: idempotency — second call must not duplicate
  const b2 = await enqueueEstimateDeactivateIfNeeded(`${PREFIX}B`);
  const { rows: b2count } = await pool.query(
    `SELECT count(*)::int AS n FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate_deactivate'`,
    [`${PREFIX}B`]
  );
  check("B2 returns null (already enqueued)", b2 === null);
  check("B2 no duplicate row", b2count[0].n === 1);

  // B3: order with no estimate → null
  await seedOrder(pool, `${PREFIX}B3`);
  const b3 = await enqueueEstimateDeactivateIfNeeded(`${PREFIX}B3`);
  check("B3 returns null (no estimate)", b3 === null);

  // B4: estimate exists but NOT confirmed → null
  await seedOrder(pool, `${PREFIX}B4`);
  await seedRow(pool, { orderId: `${PREFIX}B4`, step: "estimate", status: "pending", qbTxnId: "TEST-EST-TXN-999" });
  const b4 = await enqueueEstimateDeactivateIfNeeded(`${PREFIX}B4`);
  check("B4 returns null (estimate not confirmed)", b4 === null);

  // B5a: resubmit the pending estimate_deactivate row (QB_DRY_RUN → success)
  const { rows: b5row } = await pool.query(
    `SELECT id, order_id, reference_id, reference_type, step, qb_txn_id
       FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate_deactivate'`,
    [`${PREFIX}B`]
  );
  const stubContainer = { resolve: () => ({}) } as any;
  const stubLogger = { info: () => {}, warn: () => {}, error: () => {} };
  await resubmitByStep(b5row[0], stubContainer, stubLogger);
  const { rows: b5after } = await pool.query(
    `SELECT status, bridge_op_id FROM qb_order_pipeline WHERE id = $1`,
    [b5row[0].id]
  );
  check(
    "B5a resubmit → submitted (DRY_RUN)",
    b5after[0].status === "submitted" && !!b5after[0].bridge_op_id,
    `got status=${b5after[0].status} op=${b5after[0].bridge_op_id}`
  );

  // B5b: dispatch-pass whitelist must include estimate_deactivate (static guard)
  const dispatchSrc = fs.readFileSync(
    path.join(__dirname, "../../lib/quickbooks/consolidator/dispatch-pass.ts"),
    "utf8"
  );
  check("B5b dispatch-pass whitelist includes estimate_deactivate", dispatchSrc.includes("'estimate_deactivate'"));

  await cleanup(pool);
  await pool.end();

  console.log(`\n──────── RESULT: ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
