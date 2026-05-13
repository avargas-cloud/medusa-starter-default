/**
 * correct-vb-1004-avg-landed-cost.ts
 *
 * One-time historical fix for VB-1004 (confirmed 2026-05-08, receipt RCP-1007).
 *
 * Problem: The vendor bill confirm route used current inventory at confirm time
 * instead of inventory at receive time. For 4 SKUs, items sold between receipt
 * (2026-05-05) and confirm (2026-05-08) caused qOnHand < receivedQty, inflating
 * avg_landed_cost_cents by up to 25×.
 *
 * Additionally VB-1004 has 5 un-reversed ghost vendor_bill_cost_log entries per
 * variant (from test confirmations on 2026-05-05). The cancel route queries
 * reversed_at IS NULL, so those 40 ghost rows would cause a double-rollback if
 * VB-1004 is ever cancelled.
 *
 * This script:
 *   1. Computes correct AVCO using estimated qty_on_hand_at_receive and
 *      true prev_avg = 0 (no prior vendor bills existed for these variants).
 *   2. Updates product_variant.metadata.avg_landed_cost_cents for 4 SKUs.
 *   3. Marks 40 ghost cost_log entries (applied_at < 2026-05-06) as reversed_at.
 *   4. Corrects the 4 final cost_log rows (applied_at 2026-05-08) with the
 *      right prev_qty_on_hand, prev_avg_cost_cents, and new_avg_cost_cents.
 *
 * Dry-run by default — prints expected changes without writing anything.
 *
 *   yarn medusa exec src/scripts/fix/correct-vb-1004-avg-landed-cost.ts
 *   yarn medusa exec src/scripts/fix/correct-vb-1004-avg-landed-cost.ts --apply
 */

import { Client } from "pg";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

const VB_ID = "vb_01KQWM7N5XCV18QBSNN3301C3W"; // VB-1004
const GHOST_CUTOFF = "2026-05-06"; // ghost entries are all from 2026-05-05

// qty_on_hand_at_receive estimated retroactively:
//   current_inv + sold_since_receipt - qty_received_in_this_batch - other_receipts_since
// prevAvgCents comes from product_variant.metadata.qb_avg_cost × 100 (QB stores in dollars).
// Using qb_avg_cost as prevAvg for pre-existing units is correct — those units had a
// QB-tracked cost basis before our system started recording avg_landed_cost_cents.
const FIXES: Array<{
  sku: string;
  variantId: string;
  qBeforeReceive: number;
  prevAvgCents: number;       // qb_avg_cost × 100 for pre-existing units
  qReceived: number;
  landedUnitCostCents: number; // from vendor_bill_line — trusted (not corrupted)
  costLogIdFinal: string;     // the 2026-05-08 cost_log row to correct
  fixMetadata: boolean;
}> = [
  {
    sku: "EAP-SM5-8S",
    variantId: "variant_8-feet-slim-aluminum-channel_default",
    qBeforeReceive: 25,
    prevAvgCents: 1031.521,
    qReceived: 75,
    landedUnitCostCents: 853,
    costLogIdFinal: "a0ffb08a-b21f-421b-b24f-7ffebdedc6a9",
    fixMetadata: true,
  },
  {
    sku: "EAP-AR1-8B",
    variantId: "variant_01KK53MPM6DWJ39YRRGB4TAPF1",
    qBeforeReceive: 13,
    prevAvgCents: 1271.738,
    qReceived: 50,
    landedUnitCostCents: 988,
    costLogIdFinal: "6d8f40f6-6f6b-4ff1-8149-78db1f0f170a",
    fixMetadata: true,
  },
  {
    sku: "EAP-AR1-8S",
    variantId: "variant_8-feet-flanged-aluminum-channel_default",
    qBeforeReceive: 69,
    prevAvgCents: 1260.763,
    qReceived: 100,
    landedUnitCostCents: 948,
    costLogIdFinal: "cc45f70b-a063-4590-8917-4a348a601bc2",
    fixMetadata: true,
  },
  {
    sku: "EAP-COV1-8W",
    variantId: "variant_01KK5CFHPY4616DC0XFGA5556F",
    qBeforeReceive: 15,
    prevAvgCents: 641.66,
    qReceived: 50,
    landedUnitCostCents: 463,
    costLogIdFinal: "155d98d7-3658-4daa-9a87-cae935b1e5b7",
    fixMetadata: true,
  },
  // RM5-8S had qBefore=23 with ghost-inflated prevAvg (487.34 instead of QB's 1309.276)
  // The confirm formula ran without the inflation bug, but prevAvg was wrong — fix it too.
  {
    sku: "EAP-RM5-8S",
    variantId: "variant_8-feet-slim-flanged-aluminum-channel_default",
    qBeforeReceive: 23,
    prevAvgCents: 1309.276,
    qReceived: 25,
    landedUnitCostCents: 993,
    costLogIdFinal: "00b9b0ea-78c5-4705-91a0-7b083514f4a3",
    fixMetadata: true,
  },
  // --- qBefore = 0: prevAvg irrelevant, only update cost_log audit rows ---
  {
    sku: "EAP-AS1-8B",
    variantId: "variant_8-feet-aluminum-channel-black_default",
    qBeforeReceive: 0,
    prevAvgCents: 1067.1,
    qReceived: 50,
    landedUnitCostCents: 1091,
    costLogIdFinal: "e2a3ff61-0099-4d0a-a491-9de0cd0d6454",
    fixMetadata: false,
  },
  {
    sku: "EAP-AS1-8S",
    variantId: "variant_8-feet-aluminum-channel-silver-as1_default",
    qBeforeReceive: 0,
    prevAvgCents: 1055.493,
    qReceived: 250,
    landedUnitCostCents: 1051,
    costLogIdFinal: "624a13c5-9a6d-41ee-a13e-ab9a50d80758",
    fixMetadata: false,
  },
  {
    sku: "EAP-CP1-8S",
    variantId: "variant_8-feet-v-shape-aluminum-channel-for-90-degree-applications_default",
    qBeforeReceive: 0,
    prevAvgCents: 1634.787,
    qReceived: 50,
    landedUnitCostCents: 1311,
    costLogIdFinal: "5aba99ce-2800-4147-9600-6568f26deed8",
    fixMetadata: false,
  },
];

function computeCorrectAvg(fix: (typeof FIXES)[0]): number {
  const qOnHand = fix.qBeforeReceive + fix.qReceived;
  return qOnHand > 0
    ? (fix.qBeforeReceive * fix.prevAvgCents + fix.qReceived * fix.landedUnitCostCents) / qOnHand
    : fix.landedUnitCostCents;
}

async function run(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const mode = APPLY ? "APPLY" : "DRY RUN";
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  correct-vb-1004-avg-landed-cost  [${mode}]`);
  console.log(`${"=".repeat(60)}\n`);

  try {
    // Pre-flight: verify ghost count
    const ghostCheck = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM vendor_bill_cost_log
       WHERE vendor_bill_id = $1 AND applied_at < $2 AND reversed_at IS NULL`,
      [VB_ID, GHOST_CUTOFF]
    );
    const ghostCount = Number(ghostCheck.rows[0]?.cnt ?? 0);
    const ghostWarn = ghostCount !== 40 ? ` ⚠ expected 40` : "";
    console.log(`Ghost entries to reverse: ${ghostCount}${ghostWarn}`);

    // Print expected AVCO corrections
    console.log("\n--- AVCO corrections (prev_avg = 0 for all, first VB ever) ---");
    for (const fix of FIXES) {
      const correctAvg = computeCorrectAvg(fix);
      const { rows: curr } = await client.query<{ current_avg: string | null }>(
        `SELECT metadata->>'avg_landed_cost_cents' AS current_avg
         FROM product_variant WHERE id = $1`,
        [fix.variantId]
      );
      const currentAvg = Number(curr[0]?.current_avg ?? 0);
      const tag = fix.fixMetadata ? "FIX" : "LOG-ONLY";
      const delta = ((correctAvg - currentAvg) / Math.max(currentAvg, 1) * 100).toFixed(0);
      console.log(
        `  ${fix.sku.padEnd(14)} [${tag}]  ` +
        `current=${currentAvg.toFixed(2).padStart(9)}  →  correct=${correctAvg.toFixed(2).padStart(9)}` +
        (fix.fixMetadata ? `  (${delta >= "0" ? "+" : ""}${delta}%)` : "")
      );
    }

    if (!APPLY) {
      console.log(`\n[DRY RUN] No changes written. Pass --apply to commit.\n`);
      return;
    }

    await client.query("BEGIN");

    // 1. Mark all ghost entries for VB-1004 as reversed
    const reverseRes = await client.query(
      `UPDATE vendor_bill_cost_log
       SET reversed_at = NOW(), updated_at = NOW()
       WHERE vendor_bill_id = $1 AND applied_at < $2 AND reversed_at IS NULL`,
      [VB_ID, GHOST_CUTOFF]
    );
    console.log(`\nReversed ${reverseRes.rowCount ?? 0} ghost cost_log entries.`);

    // 2. Fix each variant
    for (const fix of FIXES) {
      const correctAvg = computeCorrectAvg(fix);
      const qOnHand = fix.qBeforeReceive + fix.qReceived;

      if (fix.fixMetadata) {
        await client.query(
          `UPDATE product_variant
           SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('avg_landed_cost_cents', $1::float),
               updated_at = NOW()
           WHERE id = $2`,
          [correctAvg, fix.variantId]
        );
      }

      // Correct the final (2026-05-08) cost_log row audit data
      await client.query(
        `UPDATE vendor_bill_cost_log
         SET prev_qty_on_hand     = $1,
             prev_avg_cost_cents  = $2,
             new_avg_cost_cents   = $3,
             updated_at           = NOW()
         WHERE id = $4`,
        [fix.qBeforeReceive, fix.prevAvgCents, correctAvg, fix.costLogIdFinal]
      );

      const tag = fix.fixMetadata ? "metadata + log" : "log only";
      console.log(
        `  ${fix.sku.padEnd(14)} avg=${correctAvg.toFixed(2).padStart(9)}  ` +
        `q_before=${String(fix.qBeforeReceive).padStart(3)}  q_total=${String(qOnHand).padStart(3)}  [${tag}]`
      );
    }

    await client.query("COMMIT");
    console.log(`\n✓ Done. Run verify-variant-avg-landed-cost.ts to confirm.\n`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
