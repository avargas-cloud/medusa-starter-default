/**
 * fix-cancelled-order-totals.ts
 *
 * Resets order_summary.totals.current_order_total to 0 for all CANCELLED orders
 * that have a negative value (caused by the bug where items had unit_price=null,
 * making declared_total ≈ $0, then cancel subtracts captured_amount → negative).
 *
 * Usage:
 *   DRY_RUN=true  npx tsx src/scripts/fix/fix-cancelled-order-totals.ts
 *   DRY_RUN=false npx tsx src/scripts/fix/fix-cancelled-order-totals.ts
 */

import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const DRY_RUN = process.env.DRY_RUN !== "false"

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log(`🔧 Fix Cancelled Order Totals (DRY_RUN=${DRY_RUN})\n`)

    // Find cancelled orders with negative current_order_total
    const negatives = await client.query(`
    SELECT
      o.display_id,
      o.id AS order_id,
      os.id AS summary_id,
      (os.totals->>'current_order_total')::float8 AS current_total,
      (os.totals->>'transaction_total')::float8    AS tx_total,
      os.updated_at
    FROM order_summary os
    JOIN "order" o ON o.id = os.order_id
    WHERE o.status = 'canceled'
      AND (os.totals->>'current_order_total')::float8 < 0
    ORDER BY o.display_id DESC
  `)

    if (negatives.rows.length === 0) {
        console.log("✅ No cancelled orders with negative totals found.")
        await client.end()
        return
    }

    console.log(`Found ${negatives.rows.length} cancelled order(s) with negative totals:\n`)
    for (const row of negatives.rows) {
        console.log(
            `  #${row.display_id} → current=$${row.current_total.toFixed(2)}  tx=$${(row.tx_total ?? 0).toFixed(2)}`
        )
    }

    if (DRY_RUN) {
        console.log("\n⚠️  DRY RUN — no changes made. Set DRY_RUN=false to apply.")
        await client.end()
        return
    }

    // Reset current_order_total and accounting_total to 0 for cancelled orders
    const ids = negatives.rows.map((r) => r.order_id)
    const result = await client.query(`
    UPDATE order_summary
    SET totals = jsonb_set(
      jsonb_set(totals, '{current_order_total}', '0'::jsonb),
      '{accounting_total}', '0'::jsonb
    )
    WHERE order_id = ANY($1::text[])
      AND (totals->>'current_order_total')::float8 < 0
  `, [ids])

    console.log(`\n✅ Reset ${result.rowCount} order_summary row(s) to $0.`)
    await client.end()
}

main().catch((err) => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
