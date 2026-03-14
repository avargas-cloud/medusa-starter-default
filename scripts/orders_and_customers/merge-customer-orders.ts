/**
 * merge-customer-orders.ts
 *
 * Re-assigns orders (and other linked data) from a deleted/legacy customer ID
 * to the currently active customer with the same email.
 *
 * Usage:
 *   npx tsx src/scripts/fix/merge-customer-orders.ts --email a.vargas@ecopowertech.com
 *   npx tsx src/scripts/fix/merge-customer-orders.ts --email a.vargas@ecopowertech.com --apply
 *
 * --apply  actually runs the UPDATE statements (default: dry-run)
 */

import * as dotenv from 'dotenv'
import { Client } from 'pg'

dotenv.config()

const APPLY = process.argv.includes('--apply')
const emailArg = process.argv.find(a => a.startsWith('--email='))?.split('=')[1]
    || process.argv[process.argv.indexOf('--email') + 1]

if (!emailArg) {
    console.error('❌ Please provide --email <email>')
    process.exit(1)
}

const DB_URL = process.env.DATABASE_URL!

async function main() {
    const db = new Client({ connectionString: DB_URL })
    await db.connect()

    console.log(`\n🔍 Looking up customers for: ${emailArg}\n`)

    // 1. Find all customers with this email (including soft-deleted)
    const { rows: customers } = await db.query(`
        SELECT id, email, first_name, last_name, has_account, created_at, deleted_at
        FROM customer
        WHERE email ILIKE $1
        ORDER BY created_at DESC
    `, [emailArg])

    if (customers.length === 0) {
        console.error(`❌ No customers found for email: ${emailArg}`)
        await db.end()
        process.exit(1)
    }

    console.log(`📋 Found ${customers.length} customer record(s):`)
    for (const c of customers) {
        const { rows: orders } = await db.query(
            `SELECT count(*) as n FROM "order" WHERE customer_id = $1`, [c.id]
        )
        const { rows: authIds } = await db.query(
            `SELECT id, app_metadata FROM auth_identity WHERE app_metadata->>'customer_id' = $1`, [c.id]
        )
        console.log(`  • ${c.id} | has_account=${c.has_account} | deleted=${c.deleted_at ? '✅ deleted' : '❌ active'} | orders=${orders[0].n} | auth_identities=${authIds.length}`)
        for (const ai of authIds) {
            console.log(`       auth_identity: ${ai.id}`)
        }
    }

    // 2. Identify active customer (not deleted, has_account=true if possible)
    const activeCustomer = customers.find(c => !c.deleted_at && c.has_account)
        || customers.find(c => !c.deleted_at)

    if (!activeCustomer) {
        console.error(`❌ No active (non-deleted) customer found for ${emailArg}`)
        await db.end()
        process.exit(1)
    }

    // 3. Find all OTHER customer IDs (legacy ones with orders)
    const legacyIds = customers
        .filter(c => c.id !== activeCustomer.id)
        .map(c => c.id)

    // ALSO check for orders with emails (in case legacy customer was hard-deleted)
    const { rows: orphanOrders } = await db.query(`
        SELECT count(*) as n FROM "order"
        WHERE email ILIKE $1
        AND customer_id != $2
    `, [emailArg, activeCustomer.id])

    // Collect all IDs to migrate FROM
    const fromIds = legacyIds
    const { rows: allLegacyOrders } = await db.query(`
        SELECT display_id, customer_id, status FROM "order"
        WHERE email ILIKE $1 AND customer_id != $2
        ORDER BY display_id
    `, [emailArg, activeCustomer.id])

    console.log(`\n✅ Active customer: ${activeCustomer.id} (${activeCustomer.first_name} ${activeCustomer.last_name})`)
    console.log(`📦 Orders to re-assign: ${allLegacyOrders.length}`)
    for (const o of allLegacyOrders) {
        console.log(`   Order #${o.display_id} [${o.status}] — from ${o.customer_id}`)
    }

    if (allLegacyOrders.length === 0) {
        console.log(`\nℹ️  No orders to re-assign. Everything is already correct.`)
        await db.end()
        return
    }

    if (!APPLY) {
        console.log(`\n⚠️  DRY RUN — no changes made. Add --apply to execute.`)
        await db.end()
        return
    }

    // 4. UPDATE orders
    const { rowCount } = await db.query(`
        UPDATE "order"
        SET customer_id = $1
        WHERE email ILIKE $2
        AND customer_id != $1
    `, [activeCustomer.id, emailArg])

    console.log(`\n✅ Updated ${rowCount} orders → customer_id = ${activeCustomer.id}`)

    // 5. Also reassign auth_identities from legacy customers to active
    for (const legacyId of legacyIds) {
        const { rowCount: aiUpdated } = await db.query(`
            UPDATE auth_identity
            SET app_metadata = jsonb_set(app_metadata, '{customer_id}', $1::jsonb)
            WHERE app_metadata->>'customer_id' = $2
        `, [`"${activeCustomer.id}"`, legacyId])

        if (aiUpdated && aiUpdated > 0) {
            console.log(`✅ Re-linked ${aiUpdated} auth_identity record(s) from ${legacyId} → ${activeCustomer.id}`)
        }
    }

    await db.end()
    console.log(`\n🎉 Done! Orders for ${emailArg} are now visible under the active account.`)
}

main().catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
})
