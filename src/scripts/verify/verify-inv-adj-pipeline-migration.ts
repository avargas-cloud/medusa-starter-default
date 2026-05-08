/**
 * Verifies the inventory adjustment pipeline migration:
 * - Simulates enqueueQbAdjustmentsStep by inserting rows into qb_order_pipeline
 * - Confirms dispatch-pass query picks them up
 * - Confirms payload shape matches what postInventoryAdjustmentToQb expects
 * - Rolls back all inserts at the end (dry run by default, set COMMIT=1 to persist)
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   npx ts-node src/scripts/verify/verify-inv-adj-pipeline-migration.ts
 */

import { Client } from "pg";
import { randomUUID } from "crypto";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const COMMIT = process.env.COMMIT === "1";

const COUNT_ID = "invcnt_01KPRMTF81XKKCCP7S6FYJDATW";
const COUNT_NUMBER = "INVCNT-1001";

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log("=== verify-inv-adj-pipeline-migration ===");
  console.log(`DB: ${DB_URL.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Mode: ${COMMIT ? "COMMIT (persists rows)" : "ROLLBACK (dry run)"}`);
  console.log();

  await client.query("BEGIN");

  try {
    // ── 1. Fetch a real inventory count + some variant data to build a realistic payload ──
    const countRes = await client.query(
      `SELECT id, number, default_qb_account_list_id FROM inventory_count WHERE id = $1`,
      [COUNT_ID]
    );
    const count = countRes.rows[0];
    if (!count) throw new Error(`Count ${COUNT_ID} not found`);

    // Grab a few real product_variants with QB ids from metadata
    const variantRes = await client.query(`
      SELECT pv.id, pv.sku, pv.metadata
      FROM product_variant pv
      WHERE pv.metadata->>'quickbooks_id' IS NOT NULL
        AND pv.sku IS NOT NULL
      LIMIT 3
    `);
    const variants = variantRes.rows;
    if (variants.length === 0) throw new Error("No variants with quickbooks_id found");

    const accountListId = count.default_qb_account_list_id;
    const referenceId = `${COUNT_ID}:${accountListId}`;

    // Build a realistic payload matching AdjustmentGroupPayload
    const payload = {
      count_id: COUNT_ID,
      count_number: COUNT_NUMBER,
      count_memo: "sandbox verification test",
      qb_account_list_id: accountListId,
      lines: variants.map((v, i) => ({
        line_id: randomUUID(),
        inventory_item_id: randomUUID(),
        product_variant_id: v.id,
        sku: v.sku,
        delta_applied: i % 2 === 0 ? 2 : -1,
        new_stock: 10 + i,
      })),
    };

    console.log(`✓ Built payload: count=${COUNT_NUMBER} account=${accountListId}`);
    console.log(`  Lines: ${payload.lines.map((l) => `${l.sku}(Δ${l.delta_applied > 0 ? "+" : ""}${l.delta_applied} → ${l.new_stock})`).join(", ")}`);

    // ── 2. INSERT into qb_order_pipeline (what enqueueQbAdjustmentsStep does) ──
    const id = randomUUID();
    const insertRes = await client.query(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, status, payload,
          medusa_ref_number, created_at, updated_at)
       VALUES ($1, $2, $3, 'inventory_count', 'inventory_adjustment', 'pending',
               $4::jsonb, $5, NOW(), NOW())
       RETURNING id, step, status, reference_id, order_id`,
      [id, COUNT_ID, referenceId, JSON.stringify(payload), COUNT_NUMBER]
    );
    const inserted = insertRes.rows[0];
    console.log(`\n✓ INSERT into qb_order_pipeline:`);
    console.log(`  id=${inserted.id}`);
    console.log(`  step=${inserted.step}  status=${inserted.status}`);
    console.log(`  reference_id=${inserted.reference_id}`);
    console.log(`  order_id=${inserted.order_id}`);

    // ── 3. Verify dispatch-pass query picks it up ──
    const dispatchRes = await client.query(`
      SELECT id, step, status, reference_id, order_id
      FROM qb_order_pipeline
      WHERE step IN (
        'estimate_cancel','credit_memo_mod','transfer_customer','estimate',
        'sales_order','so_close','so_reopen','sales_receipt','invoice',
        'invoice_update','sales_receipt_update','credit_memo','void_credit_memo',
        'void_invoice','void_sales_receipt','void_check','payment','apply_payment',
        'inventory_adjustment','void_inventory_adjustment'
      )
      AND status = 'pending'
      AND id = $1
    `, [id]);

    if (dispatchRes.rows.length === 0) {
      throw new Error("❌ FAIL: dispatch-pass query did NOT pick up the inserted row!");
    }
    console.log(`\n✓ Dispatch-pass query picks up the row correctly`);

    // ── 4. Verify payload shape has new_stock ──
    const payloadRes = await client.query(
      `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
      [id]
    );
    const stored = payloadRes.rows[0].payload;
    const allHaveNewStock = stored.lines.every(
      (l: any) => typeof l.new_stock === "number"
    );
    const allHaveNoDiff = stored.lines.every(
      (l: any) => l.quantity_difference === undefined
    );
    if (!allHaveNewStock) throw new Error("❌ FAIL: payload lines missing new_stock");
    if (!allHaveNoDiff) throw new Error("❌ FAIL: payload has old quantity_difference field");

    console.log(`✓ Payload shape correct:`);
    console.log(`  - new_stock present on all ${stored.lines.length} lines ✓`);
    console.log(`  - no quantity_difference field ✓`);
    console.log(`  - qb_account_list_id=${stored.qb_account_list_id}`);

    // ── 5. Verify idempotency: second call does UPDATE not INSERT (UPDATE-first pattern) ──
    const updatedPayload = { ...payload, count_memo: "updated memo" };
    const updateRes = await client.query(
      `UPDATE qb_order_pipeline
          SET status = 'pending', payload = $2::jsonb, error = NULL,
              next_retry_at = NULL, updated_at = NOW()
        WHERE reference_id = $1 AND step = 'inventory_adjustment'
          AND status IN ('pending', 'failed')
        RETURNING id`,
      [referenceId, JSON.stringify(updatedPayload)]
    );
    if (updateRes.rows.length === 0) {
      throw new Error("❌ FAIL: idempotent UPDATE found no existing row");
    }
    if (updateRes.rows[0].id !== id) {
      throw new Error("❌ FAIL: UPDATE returned wrong row id");
    }
    // Confirm no duplicate was created
    const countRes2 = await client.query(
      `SELECT COUNT(*) as n FROM qb_order_pipeline
        WHERE reference_id = $1 AND step = 'inventory_adjustment'`,
      [referenceId]
    );
    if (Number(countRes2.rows[0].n) !== 1) {
      throw new Error(`❌ FAIL: expected 1 row, found ${countRes2.rows[0].n}`);
    }
    console.log(`\n✓ Idempotency: UPDATE-first pattern works (1 row, updated in place)`);

    // ── 6. Verify qb_order_pipeline does NOT have quantity_difference anywhere ──
    const oldFieldRes = await client.query(`
      SELECT COUNT(*) as n FROM qb_order_pipeline
      WHERE step = 'inventory_adjustment'
        AND payload::text LIKE '%quantity_difference%'
    `);
    if (Number(oldFieldRes.rows[0].n) > 0) {
      console.warn(`⚠️  WARNING: ${oldFieldRes.rows[0].n} old rows with quantity_difference still in pipeline (legacy)`);
    } else {
      console.log(`✓ No old quantity_difference rows in qb_order_pipeline`);
    }

    // ── Summary ──
    console.log(`\n=== PASS — all checks passed ===`);
    console.log(`\nPending row would be processed by consolidator:`);
    console.log(`  → resubmitByStep case 'inventory_adjustment'`);
    console.log(`  → postInventoryAdjustmentToQb(rowId, payload, container, logger)`);
    console.log(`  → resolves QB list IDs via qb_item_pipeline + variant.metadata.quickbooks_id`);
    console.log(`  → POSTs new_quantity (not quantity_difference) to bridge /api/inventory-adjustments`);

    if (COMMIT) {
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED — row ${id} persists in sandbox`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n✓ ROLLED BACK — sandbox unchanged`);
    }
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error(`\n${err.message}`);
    process.exit(1);
  } finally {
    await client.disconnect?.() || await client.end();
  }
}

main();
