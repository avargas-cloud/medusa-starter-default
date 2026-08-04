/**
 * e2e-purchase-pipeline-mod-history-sandbox.ts
 *
 * Proves the two halves of the Purchase Pipeline audit change against a REAL
 * Postgres and the REAL enqueue path — the parts a unit test cannot reach:
 *
 *  A. Every MOD that reaches QuickBooks is its own feed record, dated when it
 *     happened, so it sorts to the top instead of hiding under the PO's
 *     creation date.
 *  B. Successive edits that have NOT been sent yet collapse into the queued
 *     operation at the chain's tail, so the log records one trip to QuickBooks
 *     carrying N edits instead of N trips.
 *
 *  And the guards that keep B from eating real history:
 *  C. An operation already in flight (submitted/processing) is never absorbed.
 *  D. A mod is never absorbed into a tail belonging to a different operation
 *     (e.g. an ItemReceipt queued in between) — that would reorder the chain.
 *  E. Retry and Mark Fixed work on the new composite ids, over real HTTP.
 *
 * ── Cómo correrlo ────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   env SANDBOX_DATABASE_URL=... ./node_modules/.bin/tsx \
 *     src/scripts/tests/e2e-purchase-pipeline-mod-history-sandbox.ts
 *
 * Seeds its own PO and pipeline rows, all tagged, and deletes them at the end.
 * QuickBooks is never contacted: the sandbox bridge is off and nothing here
 * dispatches — the consolidator is not involved.
 */
import { Client } from "pg";

import { PURCHASE_PIPELINE_FEED_SQL } from "../../api/admin/purchase-orders/qb-pipeline/_lib/feed-sql";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "../../lib/purchase-orders/qb-purchase-dependency-chain";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

/** Prefix on every row this test creates — makes cleanup trivial and total. */
const TAG = "_e2e_modhist_";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

// Fail closed on destination: this script writes PO and pipeline rows.
if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(`BASE apunta a ${BASE}; este script sólo corre contra el sandbox :9099`);
}
if (!/localhost:5499|127\.0\.0\.1:5499/.test(SB_DB)) {
  abort(`SANDBOX_DATABASE_URL apunta fuera del sandbox (:5499): ${SB_DB}`);
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

const db = new Client({ connectionString: SB_DB });

/** Minimal knex-shaped adapter: the enqueue helper takes `raw` + `transaction`. */
const knexLike = {
  raw: async (sql: string, bindings: unknown[] = []) => {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    const r = await db.query(text, bindings);
    return { rows: r.rows as unknown[], rowCount: r.rowCount ?? 0 };
  },
  transaction: async <T>(handler: (trx: typeof knexLike) => Promise<T>) => {
    await db.query("BEGIN");
    try {
      const out = await handler(knexLike);
      await db.query("COMMIT");
      return out;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  },
};

async function feedRowsFor(poId: string) {
  const { rows } = await db.query(
    `SELECT id, step, status, created_at, coalesced_edits
       FROM (${PURCHASE_PIPELINE_FEED_SQL}) f
      WHERE f.parent_id = $1
      ORDER BY created_at DESC, id DESC`,
    [poId]
  );
  return rows as Array<{
    id: string;
    step: string;
    status: string;
    created_at: Date;
    coalesced_edits: number;
  }>;
}

function poMod(poId: string, marker: string) {
  const payload = { is_mod: true, marker, lines: [{ sku: marker, qty: 1 }] };
  return {
    purchaseOrderId: poId,
    referenceId: poId,
    referenceType: "purchase_order" as const,
    step: "purchase_order_mod" as const,
    qbTxnId: "TXN-SANDBOX",
    payload,
    operationKey: purchaseOperationKey("purchase_order_mod", poId, payload),
  };
}

async function main(): Promise<void> {
  await db.connect();
  const poId = `${TAG}po_1`;
  try {
    console.log("\n🏭 Purchase Pipeline — MOD history + in-flight coalescing\n");

    await cleanup(poId);

    // A synced PO, created long ago: its legacy row keeps that old date, which
    // is exactly what used to bury every later mod.
    await db.query(
      `INSERT INTO purchase_order (id, number, status, vendor_id,
                                   stock_location_id, created_by_user_id,
                                   created_at, updated_at,
                                   qb_purchase_order_list_id,
                                   vendor_name_snapshot)
       VALUES ($1, $2, 'submitted', $3, $4, $5, NOW() - INTERVAL '90 days',
               NOW() - INTERVAL '90 days', 'QBLIST-SANDBOX', 'E2E Vendor')`,
      [
        poId,
        `${TAG}PO-9001`,
        `${TAG}vendor_1`,
        `${TAG}loc_1`,
        `${TAG}user_1`,
      ]
    );
    await db.query(
      `INSERT INTO qb_purchase_order_pipeline
         (id, purchase_order_id, status, qb_list_id, payload, retries,
          created_at, updated_at)
       VALUES ($1, $2, 'synced', 'QBLIST-SANDBOX', '{}'::jsonb, 0,
               NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days')`,
      [`${TAG}pipe_1`, poId]
    );

    // ── A · the first mod becomes its own record, dated now ────────────────
    const first = await enqueuePurchaseQbOperation(knexLike, poMod(poId, "v1"));
    let rows = await feedRowsFor(poId);
    const modRows = rows.filter((r) => r.step === "mod_purchase_order");
    check(
      "A · a mod is a record of its own",
      modRows.length === 1 && rows.length === 2,
      `${rows.length} feed rows: ${rows.map((r) => r.step).join(", ")}`
    );
    check(
      "A · and it sorts above the 90-day-old PO row",
      rows[0]?.step === "mod_purchase_order",
      `top row is ${rows[0]?.step}`
    );

    // ── B · two more unsent edits collapse into that same queued row ────────
    const second = await enqueuePurchaseQbOperation(knexLike, poMod(poId, "v2"));
    const third = await enqueuePurchaseQbOperation(knexLike, poMod(poId, "v3"));
    rows = await feedRowsFor(poId);
    const afterCollapse = rows.filter((r) => r.step === "mod_purchase_order");
    check(
      "B · three unsent edits are ONE queued operation",
      afterCollapse.length === 1 &&
        second.id === first.id &&
        third.id === first.id,
      `${afterCollapse.length} mod row(s); ids ${
        new Set([first.id, second.id, third.id]).size
      } distinct`
    );
    check(
      "B · and it reports how many edits it absorbed",
      afterCollapse[0]?.coalesced_edits === 2,
      `coalesced_edits = ${afterCollapse[0]?.coalesced_edits}`
    );
    const { rows: payloadRows } = await db.query(
      `SELECT payload->>'marker' AS marker FROM qb_order_pipeline WHERE id = $1`,
      [first.id]
    );
    check(
      "B · QuickBooks will get the LAST version, not the first",
      payloadRows[0]?.marker === "v3",
      `queued payload marker = ${payloadRows[0]?.marker}`
    );

    // ── C · once it is in flight, a new edit can no longer touch it ─────────
    await db.query(
      `UPDATE qb_order_pipeline
          SET status = 'submitted', bridge_op_id = 'op_sandbox',
              submitted_at = NOW()
        WHERE id = $1`,
      [first.id]
    );
    const fourth = await enqueuePurchaseQbOperation(knexLike, poMod(poId, "v4"));
    rows = await feedRowsFor(poId);
    check(
      "C · an in-flight operation is never overwritten",
      fourth.id !== first.id &&
        rows.filter((r) => r.step === "mod_purchase_order").length === 2,
      `new row ${fourth.id !== first.id ? "created" : "NOT created"}, ` +
        `${rows.filter((r) => r.step === "mod_purchase_order").length} mod rows`
    );
    check(
      "C · and the new one waits behind it",
      fourth.status === "waiting" && fourth.dependsOn === first.id,
      `status ${fourth.status}, depends_on ${
        fourth.dependsOn === first.id ? "the in-flight mod" : fourth.dependsOn
      }`
    );

    // ── D · a different operation at the tail blocks the merge ─────────────
    const receiptPayload = { receipt: `${TAG}r1` };
    await enqueuePurchaseQbOperation(knexLike, {
      purchaseOrderId: poId,
      referenceId: `${TAG}receipt_1`,
      referenceType: "item_receipt",
      step: "item_receipt_add",
      payload: receiptPayload,
      operationKey: purchaseOperationKey(
        "item_receipt_add",
        `${TAG}receipt_1`,
        receiptPayload
      ),
    });
    const fifth = await enqueuePurchaseQbOperation(knexLike, poMod(poId, "v5"));
    check(
      "D · a mod never jumps ahead of a receipt queued before it",
      fifth.id !== fourth.id,
      fifth.id !== fourth.id
        ? "new row appended after the receipt"
        : "WRONG: merged across the receipt",
    );

    // ── E · Retry and Mark Fixed over real HTTP, on the composite ids ───────
    const token = await login();
    await db.query(
      `UPDATE qb_order_pipeline
          SET status = 'failed', error = 'QB 3060 sandbox', failed_at = NOW(),
              next_retry_at = NULL, bridge_op_id = 'op_failed'
        WHERE id = $1`,
      [fifth.id]
    );
    const retryRes = await fetch(
      `${BASE}/admin/purchase-orders/qb-pipeline/${fifth.id}__purchase_order_mod/retry`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    const { rows: afterRetry } = await db.query(
      `SELECT status, error, bridge_op_id FROM qb_order_pipeline WHERE id = $1`,
      [fifth.id]
    );
    check(
      "E · Retry re-arms the chained mod row",
      retryRes.ok &&
        ["pending", "waiting"].includes(String(afterRetry[0]?.status)) &&
        afterRetry[0]?.bridge_op_id === null,
      `HTTP ${retryRes.status}, status ${afterRetry[0]?.status}`
    );

    const fixRes = await fetch(
      `${BASE}/admin/purchase-orders/qb-pipeline/${fifth.id}__purchase_order_mod/mark-fixed`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    const { rows: afterFix } = await db.query(
      `SELECT status FROM qb_order_pipeline WHERE id = $1`,
      [fifth.id]
    );
    check(
      "E · Mark Fixed settles it",
      fixRes.ok && afterFix[0]?.status === "fixed",
      `HTTP ${fixRes.status}, status ${afterFix[0]?.status}`
    );

    // Negative control: an id that resolves to nothing must 404, not 500 or
    // silently succeed — otherwise the two checks above prove very little.
    const bogus = await fetch(
      `${BASE}/admin/purchase-orders/qb-pipeline/${crypto.randomUUID()}__purchase_order_mod/retry`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    check(
      "E · control negativo: un id inexistente da 404",
      bogus.status === 404,
      `HTTP ${bogus.status}`
    );
  } finally {
    await cleanup(poId);
    await db.end();
  }

  console.log(
    `\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`
  );
  if (failed > 0) process.exit(1);
}

async function login(): Promise<string> {
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  if (!body.token) abort(`no se pudo loguear como ${email} (HTTP ${res.status})`);
  return body.token;
}

async function cleanup(poId: string): Promise<void> {
  await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [poId]);
  await db.query(
    `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`,
    [poId]
  );
  await db.query(
    `DELETE FROM qb_purchase_order_pipeline WHERE purchase_order_id = $1`,
    [poId]
  );
  await db.query(`DELETE FROM purchase_order WHERE id = $1`, [poId]);
}

main().catch((err) => {
  console.error("e2e-purchase-pipeline-mod-history failed:", err);
  process.exit(1);
});
