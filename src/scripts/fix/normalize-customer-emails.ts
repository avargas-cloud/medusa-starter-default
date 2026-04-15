/**
 * normalize-customer-emails.ts
 *
 * Lowercases every customer.email that contains uppercase characters, IF
 * lowercasing does not violate the unique constraint on (email, has_account)
 * WHERE deleted_at IS NULL.
 *
 * Why: Medusa v2's findOrCreateCustomerStep (node_modules/@medusajs/core-flows/
 * dist/cart/steps/find-or-create-customer.js) passes through validateEmail()
 * which lowercases the incoming email and then compares against customer.email
 * as stored in DB. When they mismatch, the step re-fetches by the lowercased
 * email and, if it doesn't find anything, creates a zombie customer with null
 * first_name/last_name/company_name. Normalizing all DB emails to lowercase
 * closes this vector at the source.
 *
 * Rows that cannot be safely lowercased (because another non-deleted row
 * already holds the lowercased email) are reported and left untouched — those
 * are the QB duplicate groups tracked in QB_Customer_Email_Fix.xlsx and
 * require human decision before they can be resolved.
 *
 * This script is idempotent: re-running it is a no-op once everything has
 * been normalized.
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/normalize-customer-emails.ts           # dry-run (safe)
 *   yarn ts-node src/scripts/fix/normalize-customer-emails.ts --execute # apply changes
 */

import "dotenv/config"
import postgres from "postgres"

const DRY_RUN = !process.argv.includes("--execute")

interface UppercaseRow {
  id: string
  email: string
  has_account: boolean
  first_name: string | null
  last_name: string | null
  company_name: string | null
  qb_list_id: string | null
}

interface CollisionRow {
  id: string
  email: string
  has_account: boolean
}

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set")
    process.exit(1)
  }

  const sql = postgres(DATABASE_URL)
  try {
    console.log(
      `\n🔍 normalize-customer-emails — ${DRY_RUN ? "DRY RUN (no changes)" : "⚡ EXECUTE MODE"}\n`
    )

    // 1. All non-deleted customers whose email contains at least one uppercase char.
    const rows = await sql<UppercaseRow[]>`
      SELECT
        c.id,
        c.email,
        c.has_account,
        c.first_name,
        c.last_name,
        c.company_name,
        c.metadata->>'qb_list_id' AS qb_list_id
      FROM customer c
      WHERE c.deleted_at IS NULL
        AND c.email IS NOT NULL
        AND c.email ~ '[A-Z]'
      ORDER BY LOWER(c.email), c.created_at
    `

    if (rows.length === 0) {
      console.log("✅ No customers with uppercase emails. Nothing to do.")
      return
    }

    console.log(
      `Found ${rows.length} customer(s) with uppercase characters in email.\n`
    )

    // 2. For each candidate, check whether LOWER(email) already exists on another
    //    non-deleted row with the same has_account. If so → collision, skip.
    //    Otherwise → safe to update.
    const safe: UppercaseRow[] = []
    const collisions: Array<{ row: UppercaseRow; collidesWith: CollisionRow }> = []

    for (const row of rows) {
      const lowered = row.email.toLowerCase()
      if (lowered === row.email) {
        continue // defensive: the regex should filter these out
      }

      const conflict = await sql<CollisionRow[]>`
        SELECT id, email, has_account
        FROM customer
        WHERE deleted_at IS NULL
          AND LOWER(email) = ${lowered}
          AND has_account = ${row.has_account}
          AND id <> ${row.id}
        LIMIT 1
      `

      if (conflict.length > 0) {
        collisions.push({ row, collidesWith: conflict[0] })
      } else {
        safe.push(row)
      }
    }

    // 3. Report plan.
    console.log(`📋 Plan:`)
    console.log(`   Safe to lowercase  : ${safe.length}`)
    console.log(`   Collisions (skip)  : ${collisions.length}`)
    console.log()

    if (collisions.length > 0) {
      console.log(`⚠️  Collisions (need human decision — these are QB dupes):`)
      for (const { row, collidesWith } of collisions) {
        const rowDesc = `${row.id} ${row.email}`
        const otherDesc = `${collidesWith.id} ${collidesWith.email}`
        console.log(`   ${rowDesc}  →  would collide with  ${otherDesc}`)
      }
      console.log()
    }

    if (safe.length > 0 && safe.length <= 50) {
      // Only dump details for small batches; 7000+ would flood the terminal.
      console.log(`🟢 Safe rows (${safe.length}):`)
      for (const row of safe) {
        const label = [
          row.first_name,
          row.last_name,
          row.company_name ? `(${row.company_name})` : null,
        ]
          .filter(Boolean)
          .join(" ")
          .trim() || "(no name)"
        console.log(
          `   ${row.id} | ${row.email} → ${row.email.toLowerCase()} | ${label} | qb=${row.qb_list_id ?? "-"}`
        )
      }
      console.log()
    } else if (safe.length > 50) {
      console.log(
        `🟢 Safe rows: ${safe.length} (not printing details — too many). Sample:\n`
      )
      for (const row of safe.slice(0, 5)) {
        console.log(`   ${row.id} | ${row.email} → ${row.email.toLowerCase()}`)
      }
      console.log(`   ... and ${safe.length - 5} more.\n`)
    }

    // 4. Execute or finish dry-run.
    if (DRY_RUN) {
      console.log(`📋 DRY RUN complete.`)
      console.log(`   Would lowercase : ${safe.length} row(s)`)
      console.log(`   Skipped         : ${collisions.length} collision(s)`)
      console.log(`   Run with --execute to apply.\n`)
      return
    }

    console.log(`⚡ Executing ${safe.length} update(s)...`)
    let updated = 0
    await sql.begin(async (trx) => {
      for (const row of safe) {
        const result = await trx`
          UPDATE customer
          SET email = LOWER(email), updated_at = NOW()
          WHERE id = ${row.id}
            AND deleted_at IS NULL
            AND email = ${row.email}
        `
        if (result.count === 1) {
          updated++
        } else {
          console.warn(
            `   ⚠️  row ${row.id} not updated (count=${result.count}) — raced or changed under us`
          )
        }
      }
    })

    console.log(`\n✅ Done. Lowercased ${updated}/${safe.length} customer email(s).`)
    if (collisions.length > 0) {
      console.log(
        `   ${collisions.length} row(s) left untouched due to collisions — resolve via QB_Customer_Email_Fix.xlsx and re-run.`
      )
    }
  } finally {
    await sql.end()
  }
}

run().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
