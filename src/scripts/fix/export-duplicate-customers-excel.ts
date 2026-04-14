/**
 * export-duplicate-customers-excel.ts
 *
 * Exports all customers with duplicate emails (case-insensitive) to
 * QB_Customer_Email_Fix.xlsx for manual review.
 *
 * Each group shows: normalized email, master candidate, all duplicates,
 * order counts, and a DECISION column for the user to fill in.
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/export-duplicate-customers-excel.ts
 *
 * Output: QB_Customer_Email_Fix.xlsx (in workspace root)
 */

import 'dotenv/config'
import postgres from 'postgres'
import * as XLSX from 'xlsx'
import path from 'path'

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

async function run() {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
        console.error('❌ DATABASE_URL not set')
        process.exit(1)
    }

    const sql = postgres(DATABASE_URL)

    try {
        // Find all groups with duplicate emails (case-insensitive)
        const duplicateEmails = await sql<{ normalized_email: string }[]>`
            SELECT LOWER(email) AS normalized_email
            FROM customer
            WHERE deleted_at IS NULL
            GROUP BY LOWER(email)
            HAVING COUNT(*) > 1
            ORDER BY LOWER(email)
        `

        if (duplicateEmails.length === 0) {
            console.log('✅ No duplicate customers found.')
            return
        }

        console.log(`Found ${duplicateEmails.length} emails with duplicates. Building Excel...`)

        const rows: Record<string, string | number>[] = []

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

            // Determine auto-suggested master (oldest, prefers has_account)
            const suggested = [...customers].sort((a, b) => {
                if (a.has_account && !b.has_account) return -1
                if (!a.has_account && b.has_account) return 1
                const aHasName = (a.first_name ?? '').trim().length > 0
                const bHasName = (b.first_name ?? '').trim().length > 0
                if (aHasName && !bHasName) return -1
                if (!aHasName && bHasName) return 1
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            })[0]

            // Is this a "zombie" pattern? (empty name + no orders)
            const isZombieGroup = customers.some(c =>
                !(c.first_name ?? '').trim() && !(c.last_name ?? '').trim() && c.order_count === '0'
            )

            // Separator row for readability
            rows.push({
                '': '──────────',
                'Normalized Email': normalized_email,
                'Customer ID': '',
                'Email (stored)': '',
                'First Name': '',
                'Last Name': '',
                'Has Account': '',
                'Created At': '',
                'Orders': '',
                'Legacy QB': '',
                'Suggested Role': '',
                'DECISION (merge/keep/change-email)': isZombieGroup ? 'merge (auto-safe)' : '⚠️ REVIEW',
            })

            for (const c of customers) {
                const isQB = !!(c.metadata as any)?.legacy_customer
                const isSuggested = c.id === suggested.id
                const isZombie = !(c.first_name ?? '').trim() && !(c.last_name ?? '').trim()

                rows.push({
                    '': '',
                    'Normalized Email': normalized_email,
                    'Customer ID': c.id,
                    'Email (stored)': c.email,
                    'First Name': c.first_name ?? '',
                    'Last Name': c.last_name ?? '',
                    'Has Account': c.has_account ? 'YES' : 'no',
                    'Created At': new Date(c.created_at).toLocaleDateString('en-US'),
                    'Orders': Number(c.order_count),
                    'Legacy QB': isQB ? 'QB' : '',
                    'Suggested Role': isSuggested
                        ? (isZombie ? '⭐ MASTER (zombie-safe)' : '⭐ MASTER')
                        : (isZombie ? '🧟 ZOMBIE' : 'duplicate'),
                    'DECISION (merge/keep/change-email)': '',
                })
            }
        }

        // Build workbook
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.json_to_sheet(rows)

        // Column widths
        ws['!cols'] = [
            { wch: 4 },   // spacer
            { wch: 32 },  // normalized email
            { wch: 30 },  // customer id
            { wch: 32 },  // stored email
            { wch: 20 },  // first name
            { wch: 20 },  // last name
            { wch: 12 },  // has_account
            { wch: 14 },  // created at
            { wch: 8 },   // orders
            { wch: 10 },  // QB
            { wch: 26 },  // suggested role
            { wch: 38 },  // decision
        ]

        XLSX.utils.book_append_sheet(wb, ws, 'Duplicate Customers')

        // Instructions sheet
        const instructions = XLSX.utils.aoa_to_sheet([
            ['QB_Customer_Email_Fix — Instructions'],
            [''],
            ['For each group of duplicates, fill in the DECISION column on the main sheet:'],
            [''],
            ['  merge          → Keep the ⭐ MASTER, soft-delete the rest. Orders reassigned to master.'],
            ['  keep           → Leave both records as-is (different companies sharing email).'],
            ['  change-email   → Update one customer\'s email in QB/Medusa to differentiate them.'],
            [''],
            ['Groups marked "merge (auto-safe)" are zombie accounts (empty name, no orders).'],
            ['Groups marked "⚠️ REVIEW" may be legitimate separate customers from QB.'],
            [''],
            ['After filling in decisions, run:'],
            ['  yarn ts-node src/scripts/fix/merge-duplicate-customers.ts --execute'],
            ['  (it will only process groups you mark as "merge")'],
        ])
        XLSX.utils.book_append_sheet(wb, instructions, 'Instructions')

        const outPath = path.join(process.cwd(), '..', 'QB_Customer_Email_Fix.xlsx')
        XLSX.writeFile(wb, outPath)

        console.log(`\n✅ Excel exported to: ${outPath}`)
        console.log(`   ${duplicateEmails.length} email groups — review the ⚠️ REVIEW rows before merging.\n`)

    } finally {
        await sql.end()
    }
}

run().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
