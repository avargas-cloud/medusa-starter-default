/**
 * merge-duplicate-customers.ts
 *
 * Finds all duplicate customer records where LOWER(email) matches across multiple rows.
 * Only auto-merges confirmed zombies: duplicates with NO qb_list_id in metadata.
 * QB customers (with qb_list_id) are skipped — the user decides those via
 * QB_Customer_Email_Fix.xlsx.
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/merge-duplicate-customers.ts           # dry-run (safe)
 *   yarn ts-node src/scripts/fix/merge-duplicate-customers.ts --execute # apply changes
 */

import 'dotenv/config'
import postgres from 'postgres'

const DRY_RUN = !process.argv.includes('--execute')

interface CustomerRow {
    id: string
    email: string
    first_name: string | null
    last_name: string | null
    has_account: boolean
    created_at: Date
    order_count: string
    metadata: Record<string, unknown> | null
}

function isQbCustomer(c: CustomerRow): boolean {
    return !!(c.metadata as any)?.qb_list_id
}

function pickMaster(customers: CustomerRow[]): CustomerRow {
    return [...customers].sort((a, b) => {
        // Prefer customers with account
        if (a.has_account && !b.has_account) return -1
        if (!a.has_account && b.has_account) return 1
        // Prefer QB customers (they're the original record)
        if (isQbCustomer(a) && !isQbCustomer(b)) return -1
        if (!isQbCustomer(a) && isQbCustomer(b)) return 1
        // Prefer customers with name data
        const aHasName = (a.first_name ?? '').trim().length > 0
        const bHasName = (b.first_name ?? '').trim().length > 0
        if (aHasName && !bHasName) return -1
        if (!aHasName && bHasName) return 1
        // Prefer oldest (original record)
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    })[0]
}

async function run() {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
        console.error('❌ DATABASE_URL not set')
        process.exit(1)
    }

    const sql = postgres(DATABASE_URL)

    try {
        console.log(`\n🔍 merge-duplicate-customers — ${DRY_RUN ? 'DRY RUN (no changes)' : '⚡ EXECUTE MODE'}\n`)

        // Find all groups with duplicate emails (case-insensitive)
        const duplicateEmails = await sql<{ normalized_email: string }[]>`
            SELECT LOWER(email) AS normalized_email
            FROM customer
            WHERE deleted_at IS NULL
            GROUP BY LOWER(email)
            HAVING COUNT(*) > 1
        `

        if (duplicateEmails.length === 0) {
            console.log('✅ No duplicate customers found. Database is clean.')
            return
        }

        console.log(`⚠️  Found ${duplicateEmails.length} email(s) with duplicates:\n`)

        let totalMerged = 0
        let totalSkipped = 0

        for (const { normalized_email } of duplicateEmails) {
            const customers = await sql<CustomerRow[]>`
                SELECT
                    c.id,
                    c.email,
                    c.first_name,
                    c.last_name,
                    c.has_account,
                    c.created_at,
                    c.metadata,
                    COUNT(o.id) AS order_count
                FROM customer c
                LEFT JOIN "order" o ON o.customer_id = c.id AND o.deleted_at IS NULL
                WHERE LOWER(c.email) = ${normalized_email}
                  AND c.deleted_at IS NULL
                GROUP BY c.id
                ORDER BY c.created_at ASC
            `

            const master = pickMaster(customers)
            const duplicates = customers.filter(c => c.id !== master.id)

            // A group is zombie-safe only when ALL non-master records have no qb_list_id.
            // If any duplicate has a qb_list_id, this is a potential QB multi-company case —
            // skip and let the user decide via QB_Customer_Email_Fix.xlsx.
            const hasQbDuplicate = duplicates.some(isQbCustomer)

            const statusIcon = hasQbDuplicate ? '⚠️  QB-SKIP' : '🧟 ZOMBIE'
            console.log(`${statusIcon} ${normalized_email}`)
            console.log(`   MASTER → ${master.id} | QB=${isQbCustomer(master)} | name="${(master.first_name ?? '').trim()} ${(master.last_name ?? '').trim()}".trim() | email="${master.email}" | orders=${master.order_count}`)
            for (const d of duplicates) {
                console.log(`   DUPL   → ${d.id} | QB=${isQbCustomer(d)} | name="${(d.first_name ?? '').trim()} ${(d.last_name ?? '').trim()}".trim() | email="${d.email}" | orders=${d.order_count}`)
            }

            if (hasQbDuplicate) {
                console.log(`   → Skipped (QB customer involved — review QB_Customer_Email_Fix.xlsx)`)
                totalSkipped++
                console.log()
                continue
            }

            if (!DRY_RUN) {
                for (const zombie of duplicates) {
                    // 1. Re-assign orders
                    const ordersResult = await sql`
                        UPDATE "order"
                        SET customer_id = ${master.id}
                        WHERE customer_id = ${zombie.id}
                          AND deleted_at IS NULL
                    `
                    console.log(`   ↳ Re-assigned ${ordersResult.count} order(s) from zombie → master`)

                    // 2. Re-assign finance/payment records if table exists
                    try {
                        const financeResult = await sql`
                            UPDATE customer_payment
                            SET customer_id = ${master.id}
                            WHERE customer_id = ${zombie.id}
                        `
                        console.log(`   ↳ Re-assigned ${financeResult.count} customer_payment record(s)`)
                    } catch {
                        // Table may not exist on all environments
                    }

                    // 3. Re-link auth_identity records
                    const authResult = await sql`
                        UPDATE auth_identity
                        SET app_metadata = jsonb_set(
                            app_metadata,
                            '{customer_id}',
                            ${`"${master.id}"`}::jsonb
                        )
                        WHERE app_metadata->>'customer_id' = ${zombie.id}
                        RETURNING id
                    `
                    console.log(`   ↳ Re-linked ${authResult.length} auth_identity record(s)`)

                    // 4. Soft-delete the zombie FIRST — must happen before normalizing
                    // master email, otherwise the existing unique constraint on
                    // (email, has_account) fires when both records share the same
                    // lowercase email.
                    await sql`
                        UPDATE customer
                        SET deleted_at = NOW()
                        WHERE id = ${zombie.id}
                    `
                    console.log(`   ↳ ✅ Zombie ${zombie.id} soft-deleted`)

                    // 5. Now safe to normalize the master's email to lowercase
                    await sql`
                        UPDATE customer
                        SET email = LOWER(email)
                        WHERE id = ${master.id}
                    `
                    console.log(`   ↳ Master email normalized to lowercase`)
                    totalMerged++
                }
            } else {
                console.log(`   [DRY RUN] Would merge ${duplicates.length} zombie(s) into master ${master.id}`)
                totalMerged += duplicates.length
            }

            console.log()
        }

        if (DRY_RUN) {
            console.log(`\n📋 DRY RUN complete.`)
            console.log(`   Would merge : ${totalMerged} zombie(s)`)
            console.log(`   Skipped (QB): ${totalSkipped} group(s) — review QB_Customer_Email_Fix.xlsx`)
            console.log(`   Run with --execute to apply.\n`)
        } else {
            console.log(`\n✅ Done.`)
            console.log(`   Merged  : ${totalMerged} zombie(s)`)
            console.log(`   Skipped : ${totalSkipped} QB group(s) — review QB_Customer_Email_Fix.xlsx\n`)
        }

    } finally {
        await sql.end()
    }
}

run().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
