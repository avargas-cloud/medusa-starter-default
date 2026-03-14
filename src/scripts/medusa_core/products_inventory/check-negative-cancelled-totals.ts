/**
 * check-negative-cancelled-totals.ts
 *
 * Finds ALL order_summary rows where current_order_total is negative
 * for cancelled orders — shows the raw data the Admin uses.
 *
 * Usage:
 *   cd backend && npx dotenv-cli -e .env -- npx tsx src/scripts/checks/check-negative-cancelled-totals.ts
 */
import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log("🔍 Checking for negative current_order_total in cancelled orders\n")

    // Check 1: negative current_order_total in order_summary
    const negRows = await client.query(`
        SELECT
          o.display_id,
          o.status,
          os.id   AS summary_id,
          (os.totals->>'current_order_total')::float8    AS current_total,
          (os.totals->>'original_order_total')::float8   AS original_total,
          (os.totals->>'transaction_total')::float8      AS tx_total,
          (os.totals->>'credit_line_total')::float8      AS credit_total,
          os.updated_at
        FROM order_summary os
        JOIN "order" o ON o.id = os.order_id
        WHERE o.status = 'canceled'
          AND (os.totals->>'current_order_total') IS NOT NULL
          AND (os.totals->>'current_order_total')::float8 < 0
        ORDER BY o.display_id DESC
    `)

    console.log(`\n📊 order_summary rows with negative current_order_total: ${negRows.rows.length}`)
    for (const r of negRows.rows) {
        console.log(`  #${r.display_id} → current=${r.current_total?.toFixed(2)}  original=${r.original_total?.toFixed(2)}  tx=${r.tx_total}  credit=${r.credit_total}`)
    }

    // Check 2: look at actual order items for a sample cancelled order showing -$121.45
    // Find one of those orders first
    const sampleOrder = await client.query(`
        SELECT o.id, o.display_id
        FROM "order" o
        WHERE o.status = 'canceled'
          AND o.display_id IN (1047, 1046, 1045, 1044, 1043)
        ORDER BY o.display_id DESC
        LIMIT 1
    `)

    if (sampleOrder.rows.length > 0) {
        const { id, display_id } = sampleOrder.rows[0]
        console.log(`\n📦 Sample order #${display_id} items (id=${id}):`)

        const items = await client.query(`
            SELECT id, variant_id, title, unit_price, quantity,
                   (unit_price * quantity) AS line_total,
                   raw_unit_price
            FROM order_item
            WHERE order_id = $1
        `, [id])

        for (const item of items.rows) {
            console.log(`  - "${item.title}" qty=${item.quantity} unit_price=${item.unit_price} line=${item.line_total}`)
            console.log(`    raw_unit_price: ${JSON.stringify(item.raw_unit_price)}`)
        }

        console.log(`\n💳 Payment collection for #${display_id}:`)
        const payments = await client.query(`
            SELECT pc.id, pc.status, pc.amount, pc.raw_amount,
                   ps.id AS session_id, ps.amount AS session_amount, ps.status AS session_status
            FROM payment_collection pc
            LEFT JOIN payment_session ps ON ps.payment_collection_id = pc.id
            WHERE pc.cart_id IN (SELECT cart_id FROM "order" WHERE id = $1)
               OR pc.order_id = $1
        `, [id])
        for (const p of payments.rows) {
            console.log(`  PC id=${p.id} status=${p.status} amount=${p.amount}`)
            if (p.session_id) console.log(`    session=${p.session_id} amount=${p.session_amount} status=${p.session_status}`)
        }
    }

    await client.end()
}

main().catch(e => { console.error("❌", e.message); process.exit(1) })
