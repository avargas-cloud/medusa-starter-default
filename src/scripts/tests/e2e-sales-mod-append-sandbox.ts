/**
 * e2e-sales-mod-append-sandbox.ts — end-to-end of the append-only sales lane
 * against the SANDBOX database (never prod: refuses any non-localhost DB).
 *
 * Exercises the real SQL of enqueueSalesMutation / claimSalesMutationRow /
 * writePipelineRow's redirect — the parts unit tests can't see (fake pools
 * never run SQL; the void-race bugs of 2026-07-29 were caught only here).
 *
 * Run:
 *   env DATABASE_URL="postgresql://postgres:sandbox@localhost:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-sales-mod-append-sandbox.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import {
  claimSalesMutationRow,
  enqueueSalesMutation,
} from "../../lib/quickbooks/pipeline/enqueue-sales-mutation";
import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const DB = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(DB)) {
  console.error("❌ Refusing to run: DATABASE_URL is not a localhost sandbox");
  process.exit(1);
}

const ORDER_ID = "order_E2E_SALES_MOD_APPEND";
const TXN_ID = "E2E-TXN-0001";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const pool = getDbPool();
  const cleanup = () =>
    pool.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [ORDER_ID]);
  await cleanup();

  // ── Seed: a confirmed ADD row, as the CREATE path leaves it ──────────────
  const { rows: seeded } = await pool.query(
    `INSERT INTO qb_order_pipeline
       (order_id, step, status, qb_txn_id, qb_result, confirmed_at, created_at)
     VALUES ($1, 'estimate', 'confirmed', $2, '{"EstimateRet":{"TxnID":"E2E-TXN-0001"}}'::jsonb,
             NOW() - interval '1 hour', NOW() - interval '1 hour')
     RETURNING id`,
    [ORDER_ID, TXN_ID]
  );
  const addRowId = seeded[0].id as string;

  // ── 1. A MOD through the legacy entrypoint lands on the NEW lane ─────────
  console.log("1. writePipelineRow(intent:'mod') redirects to estimate_mod");
  const redirectedRowId = await writePipelineRow({
    orderId: ORDER_ID,
    step: "estimate",
    status: "pending",
    intent: "mod",
    qbTxnId: TXN_ID,
    payload: { items: [{ sku: "A", qty: 1 }] },
  });
  const { rows: afterFirst } = await pool.query(
    `SELECT id, step, status, payload, confirmed_at, qb_result
       FROM qb_order_pipeline WHERE order_id = $1 ORDER BY seq`,
    [ORDER_ID]
  );
  check("a second row exists", afterFirst.length === 2);
  const modRow = afterFirst.find((r) => r.step === "estimate_mod");
  check("the new row is estimate_mod / pending", modRow?.status === "pending");
  check("redirect returned the mod row id", redirectedRowId === modRow?.id);
  const addRow = afterFirst.find((r) => r.id === addRowId);
  check(
    "ADD row keeps status confirmed",
    addRow?.status === "confirmed",
    `status=${addRow?.status}`
  );
  check(
    "ADD row keeps confirmed_at + qb_result",
    !!addRow?.confirmed_at && !!addRow?.qb_result
  );

  // ── 2. Rapid second save coalesces into the queued tail ──────────────────
  console.log("2. second save coalesces (no third row)");
  const second = await enqueueSalesMutation({
    step: "estimate_mod",
    orderId: ORDER_ID,
    qbTxnId: TXN_ID,
    payload: { items: [{ sku: "A", qty: 5 }] },
  });
  check("mode === 'coalesced'", second.mode === "coalesced");
  check("same row id", second.rowId === modRow?.id);
  const { rows: afterSecond } = await pool.query(
    `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
    [second.rowId]
  );
  // jsonb sorts object keys — compare fields, never JSON.stringify.
  const itemsAre = (
    payload: Record<string, unknown>,
    sku: string,
    qty: number
  ): boolean => {
    const items = payload.items as Array<{ sku?: string; qty?: number }>;
    return (
      Array.isArray(items) &&
      items.length === 1 &&
      items[0].sku === sku &&
      items[0].qty === qty
    );
  };
  const pl = afterSecond[0].payload as Record<string, unknown>;
  check("payload replaced with newest snapshot", itemsAre(pl, "A", 5));
  check(
    "coalesced_edits recorded 1 absorbed edit",
    Array.isArray(pl.coalesced_edits) && pl.coalesced_edits.length === 1
  );

  // ── 3. mergePayload layers keys without dropping items ───────────────────
  console.log("3. narrow mergePayload preserves queued items");
  await enqueueSalesMutation({
    step: "estimate_mod",
    orderId: ORDER_ID,
    qbTxnId: TXN_ID,
    payload: { salesRepRef: "MF" },
    mergePayload: true,
  });
  const { rows: afterMerge } = await pool.query(
    `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
    [second.rowId]
  );
  const plm = afterMerge[0].payload as Record<string, unknown>;
  check("items survived the narrow merge", itemsAre(plm, "A", 5));
  check("narrow key landed", plm.salesRepRef === "MF");

  // ── 4. claim is atomic: first wins, second is refused ────────────────────
  console.log("4. claimSalesMutationRow");
  const claim1 = await claimSalesMutationRow(second.rowId);
  const claim2 = await claimSalesMutationRow(second.rowId);
  check("first claim wins", claim1 === true);
  check("second claim refused", claim2 === false);

  // ── 5. an edit while the tail is processing inserts a SUCCESSOR row ──────
  console.log("5. processing tail is never touched — successor row inserted");
  const third = await enqueueSalesMutation({
    step: "estimate_mod",
    orderId: ORDER_ID,
    qbTxnId: TXN_ID,
    payload: { items: [{ sku: "B", qty: 1 }] },
  });
  check("mode === 'inserted'", third.mode === "inserted");
  check("different row id", third.rowId !== second.rowId);
  const { rows: processingRow } = await pool.query(
    `SELECT status, payload FROM qb_order_pipeline WHERE id = $1`,
    [second.rowId]
  );
  check(
    "processing row untouched",
    processingRow[0].status === "processing" &&
      itemsAre(processingRow[0].payload as Record<string, unknown>, "A", 5)
  );

  // ── 6. a failed tail absorbs the next edit (repair flow) ─────────────────
  console.log("6. failed tail reactivates on coalesce");
  await pool.query(
    `UPDATE qb_order_pipeline SET status = 'failed', error = 'QB 3200 stale' WHERE id = $1`,
    [third.rowId]
  );
  const fourth = await enqueueSalesMutation({
    step: "estimate_mod",
    orderId: ORDER_ID,
    qbTxnId: TXN_ID,
    payload: { items: [{ sku: "B", qty: 9 }] },
  });
  check("absorbed into the failed row", fourth.rowId === third.rowId);
  const { rows: revived } = await pool.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [third.rowId]
  );
  check("failed → pending", revived[0].status === "pending");
  check("error kept as record of the attempt", revived[0].error === "QB 3200 stale");

  // ── 7. edit while ADD in flight parks WAITING behind it ──────────────────
  console.log("7. waiting row behind an in-flight ADD (no TxnID yet)");
  await cleanup();
  const { rows: subm } = await pool.query(
    `INSERT INTO qb_order_pipeline (order_id, step, status, created_at)
     VALUES ($1, 'estimate', 'submitted', NOW()) RETURNING id`,
    [ORDER_ID]
  );
  const parked = await enqueueSalesMutation({
    step: "estimate_mod",
    orderId: ORDER_ID,
    qbTxnId: null,
    payload: {},
    status: "waiting",
    dependsOn: subm[0].id as string,
  });
  const { rows: parkedRow } = await pool.query(
    `SELECT status, depends_on FROM qb_order_pipeline WHERE id = $1`,
    [parked.rowId]
  );
  check("row is waiting", parkedRow[0].status === "waiting");
  check("depends_on the ADD row", parkedRow[0].depends_on === subm[0].id);

  // ── 8. NEGATIVE CONTROL: pending mod without TxnID is rejected ───────────
  console.log("8. negative control — pending mod without qbTxnId throws");
  let threw = false;
  try {
    await enqueueSalesMutation({
      step: "estimate_mod",
      orderId: ORDER_ID,
      qbTxnId: null,
      payload: {},
    });
  } catch {
    threw = true;
  }
  check("throws loudly", threw);

  await cleanup();
  console.log(
    failures === 0 ? "\n✅ E2E append-only lane: ALL PASS" : `\n❌ ${failures} failure(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ E2E crashed:", err);
  process.exit(1);
});
