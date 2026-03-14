/**
 * fix-cancelled-display-totals-1067-1068.ts
 *
 * Corrects the order_summary.totals for cancelled orders #1067 and #1068.
 * These orders were cancelled but their current_order_total was not zeroed out
 * because credit_line_total was not generated during cancellation (high version orders
 * that went through non-standard draft-order conversion flows).
 *
 * Fix: Set current_order_total and accounting_total to 0 directly in order_summary,
 * matching the behavior of correctly cancelled orders.
 *
 * Usage:
 *   DRY_RUN=true  npx tsx src/scripts/fix/fix-cancelled-display-totals-1067-1068.ts
 *   DRY_RUN=false npx tsx src/scripts/fix/fix-cancelled-display-totals-1067-1068.ts
 */

import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const DRY_RUN = process.env.DRY_RUN !== "false"
const TARGET_DISPLAY_IDS = [1067, 1068]

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log(`🔧 Fix Cancelled Display Totals for #${TARGET_DISPLAY_IDS.join(", #")} (DRY_RUN=${DRY_RUN})\n`)

    // Fetch current state of these orders' summaries
    const current = await client.query(`
        SELECT
          o.display_id,
          o.id AS order_id,
          o.status,
          o.version,
          os.id AS summary_id,
          (os.totals->>'current_order_total')::float8  AS current_total,
          (os.totals->>'original_order_total')::float8 AS original_total,
          (os.totals->>'credit_line_total')::float8    AS credit_line_total,
          (os.totals->>'accounting_total')::float8     AS accounting_total,
          (os.totals->>'paid_total')::float8           AS paid_total
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id AND os.version = o.version
        WHERE o.display_id = ANY($1::int[])
          AND o.deleted_at IS NULL
          AND os.deleted_at IS NULL
        ORDER BY o.display_id DESC
    `, [TARGET_DISPLAY_IDS])

    if (current.rows.length === 0) {
        console.log("❌ No order_summary rows found for target orders.")
        await client.end()
        return
    }

    console.log("Current state:\n")
    for (const row of current.rows) {
        console.log(`  #${row.display_id} (v${row.version}) status=${row.status}`)
        console.log(`    current_order_total  = $${(row.current_total ?? 0).toFixed(4)}`)
        console.log(`    original_order_total = $${(row.original_total ?? 0).toFixed(4)}`)
        console.log(`    credit_line_total    = $${(row.credit_line_total ?? 0).toFixed(4)}`)
        console.log(`    accounting_total     = $${(row.accounting_total ?? 0).toFixed(4)}`)
        console.log(`    paid_total           = $${(row.paid_total ?? 0).toFixed(4)}\n`)
    }

    if (DRY_RUN) {
        console.log("⚠️  DRY RUN — no changes made.")
        console.log("   Would zero out current_order_total and accounting_total for the above orders.")
        console.log("   Set DRY_RUN=false to apply.\n")
        await client.end()
        return
    }

    // Apply fix: zero out current_order_total, accounting_total, and pending_difference
    // Also set credit_line_total to match the original_order_total (like correctly cancelled orders)
    // Must also fix the raw_* variants that Medusa uses for precise calculations
    for (const row of current.rows) {
        const originalTotal = row.original_total ?? 0
        const ZERO_RAW = { value: "0", precision: 20 }
        const ORIG_RAW = { value: String(originalTotal), precision: 20 }

        const result = await client.query(`
            UPDATE order_summary
            SET totals = totals
              || $2::jsonb
            WHERE id = $1
        `, [row.summary_id, JSON.stringify({
            current_order_total: 0,
            accounting_total: 0,
            pending_difference: 0,
            credit_line_total: originalTotal,
            raw_current_order_total: ZERO_RAW,
            raw_accounting_total: ZERO_RAW,
            raw_pending_difference: ZERO_RAW,
            raw_credit_line_total: ORIG_RAW,
        })])

        if (result.rowCount && result.rowCount > 0) {
            console.log(`✅ #${row.display_id}: zeroed totals + raw_* fields (credit_line_total set to $${originalTotal.toFixed(4)})`)
        } else {
            console.log(`❌ #${row.display_id}: no rows updated`)
        }
    }

    // Verify
    const verify = await client.query(`
        SELECT
          o.display_id,
          (os.totals->>'current_order_total')::float8 AS current_total,
          (os.totals->>'credit_line_total')::float8   AS credit_line_total
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id
        WHERE o.display_id = ANY($1::int[])
          AND o.deleted_at IS NULL
        ORDER BY o.display_id DESC
    `, [TARGET_DISPLAY_IDS])

    console.log("\nVerification after fix:")
    for (const row of verify.rows) {
        console.log(`  #${row.display_id}: current_order_total=$${(row.current_total ?? 0).toFixed(4)}, credit_line_total=$${(row.credit_line_total ?? 0).toFixed(4)}`)
    }

    await client.end()
    console.log("\n🎉 Done!")
}

main().catch((err) => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
