/**
 * split-multi-alt-email.ts
 *
 * Finds customers whose metadata.alt_email holds MORE THAN ONE email address
 * (comma- or whitespace-separated — legacy data from earlier imports) and
 * splits them per the agreed rule:
 *
 *   • FIRST email  → stays in metadata.alt_email (singular, clean)
 *   • REST         → appended to metadata.cc_emails (comma-separated string,
 *                    merged with any pre-existing cc_emails values, deduped)
 *
 * Normalization: every email is trimmed + lowercased before comparison/save.
 *
 * Idempotent: re-running on an already-split record finds alt_email to be a
 * single clean value and classifies it as skip.
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/split-multi-alt-email.ts             # dry-run
 *   yarn ts-node src/scripts/fix/split-multi-alt-email.ts --execute   # apply
 */

import "dotenv/config"
import postgres from "postgres"

const DRY_RUN = !process.argv.includes("--execute")

interface Row {
  id: string
  email: string
  alt_email_raw: string | null
  cc_emails_raw: string | null
}

interface PlanEntry {
  id: string
  email: string
  action: "split" | "skip-single" | "skip-no-alt-email" | "skip-empty" | "error"
  before_alt_email: string | null
  before_cc_emails: string | null
  after_alt_email: string | null
  after_cc_emails: string | null
  error?: string
}

/**
 * Parse a comma- or whitespace-delimited list of emails into a clean, deduped,
 * lowercased array. Empty strings are dropped.
 */
function parseEmailList(raw: string | null): string[] {
  if (!raw) return []
  const parts = raw
    .split(/[,;\s]+/) // split on comma, semicolon, or whitespace
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  // Dedupe preserving order
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
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
      `\n🔍 split-multi-alt-email — ${DRY_RUN ? "DRY RUN (no changes)" : "⚡ EXECUTE MODE"}\n`
    )

    // We scan ALL customers with an alt_email key, then decide per-row whether
    // it actually holds multiple values. This keeps the query simple and lets
    // us report skips for transparency.
    const rows = await sql<Row[]>`
      SELECT
        id,
        email,
        metadata->>'alt_email'  AS alt_email_raw,
        metadata->>'cc_emails'  AS cc_emails_raw
      FROM customer
      WHERE deleted_at IS NULL
        AND metadata ? 'alt_email'
      ORDER BY id
    `

    console.log(`Scanned ${rows.length} customers with alt_email set.`)

    const plan: PlanEntry[] = []

    for (const row of rows) {
      const altRaw = row.alt_email_raw
      if (altRaw === null || altRaw.trim() === "") {
        plan.push({
          id: row.id,
          email: row.email,
          action: "skip-empty",
          before_alt_email: altRaw,
          before_cc_emails: row.cc_emails_raw,
          after_alt_email: altRaw,
          after_cc_emails: row.cc_emails_raw,
        })
        continue
      }

      const altList = parseEmailList(altRaw)
      if (altList.length === 0) {
        plan.push({
          id: row.id,
          email: row.email,
          action: "skip-empty",
          before_alt_email: altRaw,
          before_cc_emails: row.cc_emails_raw,
          after_alt_email: altRaw,
          after_cc_emails: row.cc_emails_raw,
        })
        continue
      }

      if (altList.length === 1) {
        // Single clean value. But the stored raw may not be lowercased/trimmed
        // — the parser output is canonical. Only mark as split if it differs.
        if (altList[0] !== altRaw) {
          plan.push({
            id: row.id,
            email: row.email,
            action: "split",
            before_alt_email: altRaw,
            before_cc_emails: row.cc_emails_raw,
            after_alt_email: altList[0],
            after_cc_emails: row.cc_emails_raw,
          })
        } else {
          plan.push({
            id: row.id,
            email: row.email,
            action: "skip-single",
            before_alt_email: altRaw,
            before_cc_emails: row.cc_emails_raw,
            after_alt_email: altRaw,
            after_cc_emails: row.cc_emails_raw,
          })
        }
        continue
      }

      // altList.length > 1 → split
      const first = altList[0]
      const rest = altList.slice(1)

      const existingCc = parseEmailList(row.cc_emails_raw)
      const mergedCc: string[] = []
      const seen = new Set<string>()
      for (const e of [...existingCc, ...rest]) {
        if (!seen.has(e) && e !== first) {
          seen.add(e)
          mergedCc.push(e)
        }
      }

      plan.push({
        id: row.id,
        email: row.email,
        action: "split",
        before_alt_email: altRaw,
        before_cc_emails: row.cc_emails_raw,
        after_alt_email: first,
        after_cc_emails: mergedCc.length > 0 ? mergedCc.join(", ") : null,
      })
    }

    // Report
    const counts: Record<string, number> = {}
    for (const p of plan) counts[p.action] = (counts[p.action] ?? 0) + 1

    console.log(`\n📋 Plan summary:`)
    for (const [action, count] of Object.entries(counts)) {
      console.log(`   ${action}: ${count}`)
    }
    console.log()

    const splits = plan.filter((p) => p.action === "split")
    if (splits.length > 0) {
      console.log(`🔀 Splits:`)
      for (const s of splits) {
        console.log(`   ${s.id} | main_email=${s.email}`)
        console.log(
          `     alt_email:  ${JSON.stringify(s.before_alt_email)}  →  ${JSON.stringify(s.after_alt_email)}`
        )
        console.log(
          `     cc_emails:  ${JSON.stringify(s.before_cc_emails)}  →  ${JSON.stringify(s.after_cc_emails)}`
        )
      }
      console.log()
    }

    if (DRY_RUN) {
      console.log(`📋 DRY RUN complete. Re-run with --execute to apply.\n`)
      return
    }

    console.log(`⚡ Executing ${splits.length} update(s)...`)
    let updated = 0
    await sql.begin(async (trx) => {
      for (const s of splits) {
        if (s.after_cc_emails === null) {
          // Only alt_email changes; drop cc_emails key if the parsed version is empty
          // AND the pre-existing cc_emails was also empty/null (don't clobber legit data).
          const preEmpty =
            s.before_cc_emails === null || s.before_cc_emails.trim() === ""
          if (preEmpty) {
            await trx`
              UPDATE customer
              SET metadata = metadata || jsonb_build_object('alt_email', ${s.after_alt_email!}::text),
                  updated_at = NOW()
              WHERE id = ${s.id}
                AND deleted_at IS NULL
            `
          } else {
            await trx`
              UPDATE customer
              SET metadata = metadata || jsonb_build_object(
                    'alt_email', ${s.after_alt_email!}::text,
                    'cc_emails', ${s.before_cc_emails!}::text
                  ),
                  updated_at = NOW()
              WHERE id = ${s.id}
                AND deleted_at IS NULL
            `
          }
        } else {
          await trx`
            UPDATE customer
            SET metadata = metadata || jsonb_build_object(
                  'alt_email', ${s.after_alt_email!}::text,
                  'cc_emails', ${s.after_cc_emails!}::text
                ),
                updated_at = NOW()
            WHERE id = ${s.id}
              AND deleted_at IS NULL
          `
        }
        updated++
      }
    })

    console.log(`\n✅ Done. Updated ${updated} customer(s).`)
  } finally {
    await sql.end()
  }
}

run().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
