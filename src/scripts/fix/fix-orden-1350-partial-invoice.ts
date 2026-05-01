/**
 * Surgical correction for Llonart Homes orden 1350 / POS Invoice 20226.
 *
 * Background: the salesperson tried to invoice partially via the
 * CompleteOrderModal but submitted with all 7 SKUs at full quantity. The
 * customer was charged $6,419.07 in full, but only 4 of the 7 SKUs were
 * actually delivered. The other 3 SKUs need to be removed from the invoice
 * + fulfillment, restored to inventory, and shown in the order as pending
 * to invoice. The customer's payment surplus ($3,384.83) is left on
 * customer_payment as `partially_applied` so it can be applied to a future
 * invoice for the remaining 3 SKUs (or refunded later).
 *
 * SKUs to remove (with original qty):
 *   - ET2-E24646-144GLD × 1
 *   - ET2-E24643-144GLD × 2
 *   - MAX-88723BK       × 3
 *
 * Run dry-run (default):
 *   yarn medusa exec ./src/scripts/fix/fix-orden-1350-partial-invoice.ts
 *
 * Run for real:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-orden-1350-partial-invoice.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { getDbPool } from "../../api/utils/db-pool";

const ORDER_ID = "order_01KP64PS82JB844N64TFJEWA0X"; // Llonart Homes orden 1350
const INVOICE_ID = "01KQG8G8KESSWKWY1V2WKQ31BT"; // POS Invoice 20226 / QB ref 19472
const FULFILLMENT_ID = "ful_01KQG8G7JW0GZ47V78MGFJ4GNF";
const PAYMENT_APPLICATION_ID = "papp_01KQG8G8SH488EFEV3H1KNH6M8";
const CUSTOMER_PAYMENT_ID = "cpay_01KPEBMA281Z36PKBYDN7Y7RKY";

const SKUS_TO_REMOVE = ["ET2-E24646-144GLD", "ET2-E24643-144GLD", "MAX-88723BK"];

// New invoice math (computed below from pos_invoice_item, but pre-stated here
// for documentation):
//   Original pos_invoice line totals at LIST: $9,118.00 (sum of pos_invoice_item.total)
//   Removed at LIST:                          $4,808.00 (2298 + 1556 + 954)
//   Remaining at LIST:                        $4,310.00
//   Remaining at WHOLESALE (× 0.80):          $3,448.00
//   12% promotion discount:                   −$413.76
//   New invoice TOTAL:                        $3,034.24
//   New `discount` field (LIST − final):      $1,275.76
//   Surplus on customer_payment:              $3,384.83 ($6,419.07 − $3,034.24)
const EXPECTED_NEW_TOTAL_CENTS = 303424;
const EXPECTED_NEW_DISCOUNT_CENTS = 127576;
const EXPECTED_SURPLUS_CENTS = 338483;

interface ChangeLog {
  table: string;
  action: string;
  before: any;
  after: any;
}

export default async function fixOrden1350({
  container,
}: {
  container: MedusaContainer;
}) {
  const APPLY = process.env.APPLY === "1";
  const banner = APPLY ? "🔥 APPLY MODE" : "🔍 DRY-RUN MODE";

  console.log(`\n${banner} — fix orden 1350 / Invoice 20226 / QB ref 19472\n`);

  const pool = getDbPool();
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // ─── 1. Read current state ─────────────────────────────────────────────
  const { rows: invItems } = await pool.query(
    `SELECT id, sku, description, quantity, unit_price, total
       FROM pos_invoice_item
      WHERE invoice_id = $1 AND deleted_at IS NULL
      ORDER BY created_at`,
    [INVOICE_ID]
  );
  console.log(`pos_invoice_item rows currently on invoice: ${invItems.length}`);
  for (const it of invItems) {
    const flag = SKUS_TO_REMOVE.includes(it.sku) ? "🗑️" : "✅";
    console.log(
      `  ${flag} ${it.sku} qty=${it.quantity} unit=$${(it.unit_price / 100).toFixed(2)} total=$${(it.total / 100).toFixed(2)}`
    );
  }

  const toRemove = invItems.filter((r: any) => SKUS_TO_REMOVE.includes(r.sku));
  const toKeep = invItems.filter((r: any) => !SKUS_TO_REMOVE.includes(r.sku));
  if (toRemove.length !== SKUS_TO_REMOVE.length) {
    console.log(
      `❌ Expected ${SKUS_TO_REMOVE.length} matching SKUs, found ${toRemove.length}. Aborting.`
    );
    process.exitCode = 1;
    return;
  }

  // ─── 2. Compute new invoice totals ─────────────────────────────────────
  const removedListCents = toRemove.reduce(
    (s: number, r: any) => s + Number(r.total),
    0
  );
  const remainingListCents = toKeep.reduce(
    (s: number, r: any) => s + Number(r.total),
    0
  );
  console.log(
    `\nList totals: removing $${(removedListCents / 100).toFixed(2)}, keeping $${(remainingListCents / 100).toFixed(2)}`
  );

  // The final invoice total is wholesale (×0.80) × 0.88 (12% promo)
  const newTotalCents = Math.round(remainingListCents * 0.8 * 0.88);
  const newDiscountCents = remainingListCents - newTotalCents;

  console.log(
    `New invoice total: $${(newTotalCents / 100).toFixed(2)} (expected $${(EXPECTED_NEW_TOTAL_CENTS / 100).toFixed(2)})`
  );
  console.log(
    `New discount field: $${(newDiscountCents / 100).toFixed(2)} (expected $${(EXPECTED_NEW_DISCOUNT_CENTS / 100).toFixed(2)})`
  );

  if (
    Math.abs(newTotalCents - EXPECTED_NEW_TOTAL_CENTS) > 5 ||
    Math.abs(newDiscountCents - EXPECTED_NEW_DISCOUNT_CENTS) > 5
  ) {
    console.log(
      "❌ New totals diverge from expected by more than $0.05. Aborting."
    );
    process.exitCode = 1;
    return;
  }

  // ─── 3. Read current invoice + payment application + fulfillment ──────
  const { rows: invRows } = await pool.query(
    `SELECT subtotal, discount, tax, untaxed_total, total, balance_due
       FROM pos_invoice WHERE id = $1`,
    [INVOICE_ID]
  );
  const inv = invRows[0];

  const { rows: papps } = await pool.query(
    `SELECT id, amount_applied, voided_at
       FROM payment_application WHERE id = $1`,
    [PAYMENT_APPLICATION_ID]
  );
  const papp = papps[0];

  const { rows: cpays } = await pool.query(
    `SELECT id, status, amount FROM customer_payment WHERE id = $1`,
    [CUSTOMER_PAYMENT_ID]
  );
  const cpay = cpays[0];

  const { rows: fulItems } = await pool.query(
    `SELECT id, sku, quantity, line_item_id, inventory_item_id
       FROM fulfillment_item
      WHERE fulfillment_id = $1 AND deleted_at IS NULL`,
    [FULFILLMENT_ID]
  );

  const fulToRemove = fulItems.filter((r: any) =>
    SKUS_TO_REMOVE.includes(r.sku)
  );

  // ─── 4. Read order_item versions to update fulfilled/delivered ─────────
  const itemIdsToZero = Array.from(
    new Set(fulToRemove.map((r: any) => r.line_item_id))
  );
  const { rows: orderItems } = await pool.query(
    `SELECT id, item_id, version, quantity, fulfilled_quantity,
            delivered_quantity, shipped_quantity
       FROM order_item
      WHERE order_id = $1 AND item_id = ANY($2::text[]) AND deleted_at IS NULL`,
    [ORDER_ID, itemIdsToZero]
  );

  // ─── 5. Inventory levels ───────────────────────────────────────────────
  const inventoryItemIds = Array.from(
    new Set(fulToRemove.map((r: any) => r.inventory_item_id).filter(Boolean))
  );
  const { rows: invLevels } = await pool.query(
    `SELECT inventory_item_id, location_id, stocked_quantity, reserved_quantity
       FROM inventory_level
      WHERE inventory_item_id = ANY($1::text[])`,
    [inventoryItemIds]
  );

  // Map inventory_item_id → SKU + qty to restore (sum across fulfillment_item rows)
  const restoreMap: Record<string, { sku: string; qty: number }> = {};
  for (const fi of fulToRemove) {
    if (!fi.inventory_item_id) continue;
    const key = fi.inventory_item_id;
    if (!restoreMap[key]) restoreMap[key] = { sku: fi.sku, qty: 0 };
    // Each fulfillment_item row corresponds to a single fulfillment delivery
    // of `quantity` units. Sum but NOTE: there can be duplicate rows from
    // version history. Distinct ids only:
  }
  // Sum unique fulfillment_item.id (avoid double-counting from any DB join glitches)
  const uniqueFulRows = new Map<string, any>();
  for (const fi of fulToRemove) {
    uniqueFulRows.set(fi.id, fi);
  }
  for (const fi of uniqueFulRows.values()) {
    if (!fi.inventory_item_id) continue;
    const key = fi.inventory_item_id;
    if (!restoreMap[key]) restoreMap[key] = { sku: fi.sku, qty: 0 };
    restoreMap[key].qty += Number(fi.quantity);
  }

  console.log("\nInventory restore plan (per inventory_item):");
  for (const [iid, { sku, qty }] of Object.entries(restoreMap)) {
    console.log(`  ${sku} (${iid}): +${qty} stocked`);
  }

  // ─── 6. Backup snapshot ─────────────────────────────────────────────────
  const backup = {
    timestamp: new Date().toISOString(),
    order_id: ORDER_ID,
    invoice_id: INVOICE_ID,
    invoice_state_before: inv,
    payment_application_before: papp,
    customer_payment_before: cpay,
    pos_invoice_items_before: invItems,
    fulfillment_items_before: Array.from(uniqueFulRows.values()),
    order_items_before: orderItems,
    inventory_levels_before: invLevels,
    new_invoice_totals: {
      total_cents: newTotalCents,
      discount_cents: newDiscountCents,
      surplus_cents: EXPECTED_SURPLUS_CENTS,
    },
  };

  const backupDir = "/home/alejo/webapps/ecopowertech-workspace/mem/orden-1350-fix";
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(
    backupDir,
    `backup-${APPLY ? "apply" : "dryrun"}-${Date.now()}.json`
  );
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written to: ${backupPath}`);

  if (!APPLY) {
    console.log("\n🔍 DRY-RUN complete. Re-run with APPLY=1 to execute.");
    return;
  }

  // ═══ APPLY MODE — wrap in a single transaction for atomicity ══════════
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 6a. Soft-delete the 3 pos_invoice_item rows
    const { rowCount: rmInvItems } = await client.query(
      `UPDATE pos_invoice_item
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [toRemove.map((r: any) => r.id)]
    );
    console.log(`✓ Soft-deleted ${rmInvItems} pos_invoice_item rows`);

    // 6b. Update pos_invoice totals
    const { rowCount: invUpd } = await client.query(
      `UPDATE pos_invoice
          SET subtotal      = $2,
              discount      = $3,
              raw_discount  = jsonb_build_object('value', ($3::numeric/100)::text, 'precision', 20),
              total         = $2,
              raw_total     = jsonb_build_object('value', ($2::numeric/100)::text, 'precision', 20),
              untaxed_total = $2,
              raw_untaxed_total = jsonb_build_object('value', ($2::numeric/100)::text, 'precision', 20),
              raw_subtotal  = jsonb_build_object('value', ($2::numeric/100)::text, 'precision', 20),
              balance_due   = 0,
              raw_balance_due = jsonb_build_object('value', '0', 'precision', 20),
              updated_at    = NOW()
        WHERE id = $1`,
      [INVOICE_ID, newTotalCents, newDiscountCents]
    );
    console.log(`✓ Updated ${invUpd} pos_invoice rows`);

    // 6c. Void existing payment_application + create new one for new total
    const { rowCount: voidedApp } = await client.query(
      `UPDATE payment_application
          SET voided_at = NOW(),
              void_reason = 'Invoice corrected — orden 1350 partial fulfillment fix',
              updated_at = NOW()
        WHERE id = $1 AND voided_at IS NULL`,
      [PAYMENT_APPLICATION_ID]
    );
    console.log(`✓ Voided ${voidedApp} payment_application`);

    const newAppId = `papp_${ulid()}`;
    await client.query(
      `INSERT INTO payment_application
         (id, payment_id, invoice_id, order_id, amount_applied, raw_amount_applied,
          applied_at, applied_by, invoice_number)
       VALUES ($1, $2, $3, $4, $5,
               jsonb_build_object('value', ($5::numeric/100)::text, 'precision', 20),
               NOW(), 'fix-script-orden-1350', '20226')`,
      [
        newAppId,
        CUSTOMER_PAYMENT_ID,
        INVOICE_ID,
        ORDER_ID,
        newTotalCents,
      ]
    );
    console.log(`✓ Created new payment_application ${newAppId} for $${(newTotalCents / 100).toFixed(2)}`);

    // 6d. Update customer_payment.status
    const { rowCount: cpayUpd } = await client.query(
      `UPDATE customer_payment
          SET status = 'partially_applied', updated_at = NOW()
        WHERE id = $1`,
      [CUSTOMER_PAYMENT_ID]
    );
    console.log(`✓ Updated ${cpayUpd} customer_payment to partially_applied`);

    // 6e. Soft-delete fulfillment_item rows
    const fulIdsToRm = Array.from(uniqueFulRows.values()).map((r: any) => r.id);
    const { rowCount: rmFulItems } = await client.query(
      `UPDATE fulfillment_item
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [fulIdsToRm]
    );
    console.log(`✓ Soft-deleted ${rmFulItems} fulfillment_item rows`);

    // 6f. Zero out fulfilled/shipped/delivered quantities on order_item
    const { rowCount: oiUpd } = await client.query(
      `UPDATE order_item
          SET fulfilled_quantity = 0,
              raw_fulfilled_quantity = '{"value": "0", "precision": 20}'::jsonb,
              shipped_quantity = 0,
              raw_shipped_quantity = '{"value": "0", "precision": 20}'::jsonb,
              delivered_quantity = 0,
              raw_delivered_quantity = '{"value": "0", "precision": 20}'::jsonb,
              updated_at = NOW()
        WHERE order_id = $1 AND item_id = ANY($2::text[]) AND deleted_at IS NULL`,
      [ORDER_ID, itemIdsToZero]
    );
    console.log(`✓ Zeroed fulfilled/shipped/delivered on ${oiUpd} order_item rows`);

    // 6g. Restore inventory: stocked_quantity += removed qty per inventory_item
    let restored = 0;
    for (const [iid, { sku, qty }] of Object.entries(restoreMap)) {
      const { rowCount } = await client.query(
        `UPDATE inventory_level
            SET stocked_quantity = stocked_quantity + $2,
                raw_stocked_quantity = jsonb_build_object(
                  'value', (stocked_quantity + $2)::text,
                  'precision', 20
                ),
                updated_at = NOW()
          WHERE inventory_item_id = $1`,
        [iid, qty]
      );
      console.log(`✓ Restored ${qty} units to inventory for ${sku} (${rowCount} levels)`);
      restored += rowCount ?? 0;
    }

    await client.query("COMMIT");
    console.log("\n✅ Transaction COMMITTED.");
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error(`\n❌ Transaction ROLLED BACK due to error: ${err.message}`);
    process.exitCode = 1;
    throw err;
  } finally {
    client.release();
  }

  // ─── 7. Verification ────────────────────────────────────────────────────
  console.log("\n=== Post-fix verification ===");
  const { rows: vInv } = await pool.query(
    `SELECT subtotal, discount, total, balance_due FROM pos_invoice WHERE id = $1`,
    [INVOICE_ID]
  );
  console.log(`pos_invoice: ${JSON.stringify(vInv[0])}`);

  const { rows: vItems } = await pool.query(
    `SELECT sku, quantity FROM pos_invoice_item WHERE invoice_id = $1 AND deleted_at IS NULL`,
    [INVOICE_ID]
  );
  console.log(`pos_invoice_item rows now: ${vItems.length}`);
  for (const it of vItems) console.log(`  ${it.sku} qty=${it.quantity}`);

  const { rows: vPapps } = await pool.query(
    `SELECT id, amount_applied/100.0 AS amount, voided_at FROM payment_application
      WHERE invoice_id = $1`,
    [INVOICE_ID]
  );
  console.log(`payment_applications: ${JSON.stringify(vPapps)}`);

  const { rows: vCpay } = await pool.query(
    `SELECT status, amount/100.0 AS amount FROM customer_payment WHERE id = $1`,
    [CUSTOMER_PAYMENT_ID]
  );
  console.log(`customer_payment: ${JSON.stringify(vCpay[0])}`);

  console.log("\n📌 NEXT STEP: trigger QB Invoice Mod for ref 19472 manually");
  console.log("   (the QB pipeline will pick up new totals via consolidator");
  console.log("   pending dispatch when an invoice_update row is enqueued).");
}

// Tiny ULID generator for new payment_application id (avoids importing the
// full @medusajs ulid which has a different invocation surface in scripts).
function ulid(): string {
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  let timeStr = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timeStr = ENCODING[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[Math.floor(Math.random() * 32)];
  }
  return timeStr + randStr;
}
