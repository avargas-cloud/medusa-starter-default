#!/usr/bin/env tsx
/**
 * fix-order-summary-duplicates.ts
 *
 * Removes duplicate order_summary rows created by the old workflow behavior.
 * Each canceled order has 2 rows: the original (before cancel) and one created
 * by cancelOrderWorkflow (current=0). The Admin needs exactly ONE row per order.
 *
 * Strategy: for each order with duplicates, keep the LATEST row (most recent
 * updated_at) and delete the older one(s). For canceled orders, the latest
 * row has current_order_total=0 which is the correct state (shows "-" in Admin
 * = expected behavior, same as local).
 *
 * Usage: npx -y tsx src/scripts/fix/fix-order-summary-duplicates.ts [--dry-run]
 */
import { Client } from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log(`✅ Connected to Railway DB ${DRY_RUN ? '(DRY RUN)' : ''}\n`)

    // Find all orders with duplicate order_summary rows
    const dupes = await client.query(`
        SELECT 
            order_id,
            COUNT(*) as row_count,
            array_agg(id ORDER BY updated_at DESC) as ids_newest_first,
            array_agg((totals->>'current_order_total')::text ORDER BY updated_at DESC) as totals_newest_first
        FROM order_summary
        GROUP BY order_id
        HAVING COUNT(*) > 1
        ORDER BY MAX(updated_at) DESC
    `)

    if (dupes.rows.length === 0) {
        console.log('✅ No duplicate order_summary rows found. Nothing to clean.')
        await client.end()
        return
    }

    console.log(`Found ${dupes.rows.length} orders with duplicate order_summary rows:\n`)

    let deletedCount = 0
    for (const row of dupes.rows) {
        const [keepId, ...deleteIds] = row.ids_newest_first
        const [keepTotal, ...deleteTotals] = row.totals_newest_first
        console.log(`  order_id: ${row.order_id}`)
        console.log(`    KEEP   id=${keepId}  current_total=${keepTotal}`)
        for (let i = 0; i < deleteIds.length; i++) {
            console.log(`    DELETE id=${deleteIds[i]} current_total=${deleteTotals[i]}`)
        }

        if (!DRY_RUN) {
            await client.query(
                `DELETE FROM order_summary WHERE id = ANY($1::text[])`,
                [deleteIds]
            )
            deletedCount += deleteIds.length
        }
        console.log()
    }

    if (DRY_RUN) {
        console.log(`\n[DRY RUN] Would delete ${dupes.rows.reduce((acc, r) => acc + r.ids_newest_first.length - 1, 0)} rows.`)
        console.log('Run without --dry-run to apply changes.')
    } else {
        console.log(`✅ Deleted ${deletedCount} duplicate order_summary row(s).`)
        console.log('The Admin will now read consistent data for all affected orders.')
    }

    await client.end()
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
