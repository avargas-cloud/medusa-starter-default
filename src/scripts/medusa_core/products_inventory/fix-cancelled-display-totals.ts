/**
 * fix-cancelled-display-totals.ts
 *
 * Fixes the Medusa Admin showing $0 for cancelled orders.
 *
 * Root cause: cancelOrderWorkflow creates a 2nd order_summary row where
 *   current_order_total = 0  (credit_line_total = original amount)
 * The Admin reads the latest row and shows $0.
 *
 * Fix:
 *   1. Remove duplicate order_summary rows (keep the latest per order)
 *   2. For cancelled orders where current_order_total=0 but original_order_total>0,
 *      restore current_order_total = original_order_total (display only — financial
 *      fields credit_line_total / transaction_total remain untouched).
 *
 * Usage:
 *   DRY_RUN=true  npx dotenv-cli -e .env -- npx tsx src/scripts/fix/fix-cancelled-display-totals.ts
 *   DRY_RUN=false npx dotenv-cli -e .env -- npx tsx src/scripts/fix/fix-cancelled-display-totals.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`🔧 Fix Cancelled Order Display Totals (DRY_RUN=${DRY_RUN})\n`);

  // ── STEP 1: Remove duplicates — keep latest row per order ──────────────────
  const dupes = await client.query(`
        SELECT
          order_id,
          COUNT(*) AS cnt,
          array_agg(id ORDER BY updated_at DESC) AS ids_newest_first,
          array_agg((totals->>'current_order_total') ORDER BY updated_at DESC) AS totals_newest_first
        FROM order_summary
        GROUP BY order_id
        HAVING COUNT(*) > 1
        ORDER BY MAX(updated_at) DESC
    `);

  if (dupes.rows.length > 0) {
    console.log(
      `Found ${dupes.rows.length} orders with duplicate order_summary rows:`
    );
    let totalDupes = 0;
    const toDelete: string[] = [];

    for (const row of dupes.rows) {
      const [keepId, ...deleteIds] = row.ids_newest_first;
      const [keepTotal] = row.totals_newest_first;
      console.log(
        `  order_id: ${row.order_id} → KEEP ${keepId} (current=${keepTotal}), DELETE ${deleteIds.length} older row(s)`
      );
      toDelete.push(...deleteIds);
      totalDupes += deleteIds.length;
    }

    if (!DRY_RUN && toDelete.length > 0) {
      await client.query(
        `DELETE FROM order_summary WHERE id = ANY($1::text[])`,
        [toDelete]
      );
      console.log(`✅ Deleted ${toDelete.length} duplicate row(s)\n`);
    } else {
      console.log(`[DRY RUN] Would delete ${totalDupes} duplicate row(s)\n`);
    }
  } else {
    console.log("✅ No duplicate order_summary rows found\n");
  }

  // ── STEP 2: Find cancelled orders with current_order_total=0 but original>0 ─
  const candidates = await client.query(`
        SELECT
          os.id         AS summary_id,
          o.display_id,
          o.id          AS order_id,
          (os.totals->>'current_order_total')::float8  AS current_total,
          (os.totals->>'original_order_total')::float8 AS original_total,
          os.totals->>'raw_original_order_total'        AS raw_original_json
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id
        WHERE o.status = 'canceled'
          AND (os.totals->>'current_order_total')::float8 = 0
          AND (os.totals->>'original_order_total')::float8 > 0
        ORDER BY o.display_id DESC
    `);

  if (candidates.rows.length === 0) {
    console.log("✅ No cancelled orders need display-total fix.");
    await client.end();
    return;
  }

  console.log(`Found ${candidates.rows.length} cancelled order(s) to fix:\n`);
  for (const row of candidates.rows) {
    console.log(
      `  #${row.display_id} → current=$${row.current_total.toFixed(2)} → will set $${row.original_total.toFixed(2)}`
    );
  }

  if (DRY_RUN) {
    console.log("\n⚠️  DRY RUN — no changes made. Set DRY_RUN=false to apply.");
    await client.end();
    return;
  }

  // ── STEP 3: Apply the fix ────────────────────────────────────────────────────
  // Set current_order_total AND raw_current_order_total to original values
  // Leave credit_line_total / accounting_total / transaction_total untouched.
  let fixed = 0;
  for (const row of candidates.rows) {
    const rawOriginal = JSON.parse(row.raw_original_json || "{}");
    await client.query(
      `
            UPDATE order_summary
            SET totals = jsonb_set(
              jsonb_set(
                totals,
                '{current_order_total}',
                to_jsonb((totals->>'original_order_total')::float8)
              ),
              '{raw_current_order_total}',
              $1::jsonb
            )
            WHERE id = $2
        `,
      [JSON.stringify(rawOriginal), row.summary_id]
    );
    fixed++;
  }

  console.log(`\n✅ Fixed display total for ${fixed} cancelled order(s).`);
  await client.end();
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
