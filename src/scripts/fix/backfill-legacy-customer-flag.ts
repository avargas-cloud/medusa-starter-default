/**
 * BACKFILL: Add legacy_customer:true to all QB-imported customers
 *
 * Targets: customers with qb_list_id in metadata but WITHOUT legacy_customer:true
 * Run once after deploying sync-customers-core.ts fix.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/fix/backfill-legacy-customer-flag.ts
 */

import * as dotenv from 'dotenv'
dotenv.config()

import { Client } from 'pg'

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    console.log('🔍 Finding QB customers without legacy_customer flag...')

    // Find all customers that have qb_list_id but NOT legacy_customer:true
    const { rows: targets } = await client.query(`
        SELECT id, email, first_name, last_name, metadata
        FROM customer
        WHERE has_account = false
          AND metadata IS NOT NULL
          AND metadata::jsonb ? 'qb_list_id'
          AND (
            metadata::jsonb->>'legacy_customer' IS NULL
            OR metadata::jsonb->>'legacy_customer' != 'true'
          )
        ORDER BY email
    `)

    console.log(`\n📊 Found ${targets.length} customers to backfill:\n`)

    if (targets.length === 0) {
        console.log('✅ All QB customers already have legacy_customer:true — nothing to do.')
        await client.end()
        return
    }

    // Preview
    targets.slice(0, 10).forEach((c: any) => {
        console.log(`  • ${c.email} (${c.first_name} ${c.last_name})`)
    })
    if (targets.length > 10) {
        console.log(`  ... and ${targets.length - 10} more`)
    }

    console.log('\n⚙️  Applying backfill...')

    let updated = 0
    let errors = 0

    for (const customer of targets) {
        try {
            // Merge legacy_customer:true into existing metadata
            await client.query(`
                UPDATE customer
                SET metadata = metadata::jsonb || '{"legacy_customer": true}'::jsonb
                WHERE id = $1
            `, [customer.id])
            updated++
        } catch (err: any) {
            console.error(`  ❌ Failed for ${customer.email}: ${err.message}`)
            errors++
        }
    }

    console.log(`\n✅ Backfill complete:`)
    console.log(`   Updated: ${updated}`)
    console.log(`   Errors:  ${errors}`)

    // Verify
    const { rows: verify } = await client.query(`
        SELECT COUNT(*)::int as count FROM customer
        WHERE metadata::jsonb ? 'qb_list_id'
          AND metadata::jsonb->>'legacy_customer' = 'true'
    `)
    console.log(`\n📊 Total QB customers with legacy_customer:true — ${verify[0].count}`)

    await client.end()
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
