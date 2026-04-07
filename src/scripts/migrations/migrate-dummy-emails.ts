import { Client } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

/**
 * Migrates old dummy emails (customer-{ListID}@ecopowertech.com)
 * to the new readable format ({name-slug}@noemail.ecopowertech.com)
 *
 * Run: DRY_RUN=true yarn ts-node src/scripts/migrations/migrate-dummy-emails.ts
 * Run: DRY_RUN=false yarn ts-node src/scripts/migrations/migrate-dummy-emails.ts
 */

const DRY_RUN = process.env.DRY_RUN !== "false"

function toEmailSlug(firstName: string, lastName: string): string {
    const raw = `${firstName} ${lastName}`.trim()
    return raw
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")   // strip accents
        .replace(/[^a-z0-9\s]/g, "")        // remove special chars
        .trim()
        .replace(/\s+/g, ".")               // spaces → dots
        || "customer"
}

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    console.log(`\n📧 Dummy Email Migration — ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`)

    const { rows } = await client.query<{
        id: string
        first_name: string
        last_name: string
        email: string
    }>(`
        SELECT id, first_name, last_name, email
        FROM customer
        WHERE deleted_at IS NULL
          AND email ILIKE 'customer-%@ecopowertech.com'
        ORDER BY created_at
    `)

    console.log(`Found ${rows.length} customers with old dummy email format\n`)

    // Build a set of all existing emails to detect collisions
    const { rows: allEmails } = await client.query<{ email: string }>(
        `SELECT email FROM customer WHERE deleted_at IS NULL`
    )
    const takenEmails = new Set(allEmails.map(r => r.email.toLowerCase()))

    let updated = 0
    let skipped = 0
    const changes: { id: string; old: string; new: string }[] = []

    for (const row of rows) {
        const baseSlug = toEmailSlug(row.first_name || "", row.last_name || "")
        let candidate = `${baseSlug}@noemail.ecopowertech.com`

        // Resolve collision
        let suffix = 2
        while (takenEmails.has(candidate) && candidate !== row.email.toLowerCase()) {
            candidate = `${baseSlug}.${suffix}@noemail.ecopowertech.com`
            suffix++
        }

        if (candidate === row.email.toLowerCase()) {
            skipped++
            continue
        }

        changes.push({ id: row.id, old: row.email, new: candidate })
        takenEmails.add(candidate)          // reserve for next iterations
        takenEmails.delete(row.email.toLowerCase())
    }

    // Preview first 30
    console.log(`📋 Sample changes (first 30):`)
    for (const c of changes.slice(0, 30)) {
        console.log(`   ${c.old}`)
        console.log(`   → ${c.new}\n`)
    }
    if (changes.length > 30) console.log(`   ... and ${changes.length - 30} more\n`)

    console.log(`\nSummary:`)
    console.log(`  Would update: ${changes.length}`)
    console.log(`  Skipped (no change needed): ${skipped}`)

    if (DRY_RUN) {
        console.log(`\n⚠️  DRY RUN — no changes written. Re-run with DRY_RUN=false to apply.`)
        await client.end()
        return
    }

    // Apply in batches of 100
    await client.query("BEGIN")
    try {
        let count = 0
        for (const c of changes) {
            await client.query(
                `UPDATE customer SET email = $1, updated_at = NOW() WHERE id = $2`,
                [c.new, c.id]
            )
            count++
            if (count % 100 === 0) console.log(`   Updated ${count}/${changes.length}...`)
        }
        await client.query("COMMIT")
        console.log(`\n✅ Done — updated ${changes.length} customer emails.`)
    } catch (err) {
        await client.query("ROLLBACK")
        console.error(`\n❌ Error — rolled back:`, (err as Error).message)
        process.exit(1)
    }

    await client.end()
}

main().catch(err => {
    console.error("Fatal:", err.message)
    process.exit(1)
})
