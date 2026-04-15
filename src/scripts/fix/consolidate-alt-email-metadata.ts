/**
 * consolidate-alt-email-metadata.ts
 *
 * Consolidates the legacy `metadata.alt_emails` (plural, comma-separated string
 * written by import-customers-from-qb.ts) into `metadata.alt_email` (singular,
 * the shape used by the POS UI in AddCustomerModal and CustomerDetailsCard).
 *
 * Rules:
 *   1. If customer has `alt_emails` (plural) and NO `alt_email` (singular):
 *        → Split by comma, move FIRST value to `alt_email`, drop `alt_emails`.
 *        → If there were extras (more than one), log them for manual review.
 *   2. If customer has BOTH `alt_emails` and `alt_email`:
 *        → Keep existing `alt_email`, drop `alt_emails`.
 *        → If extras from alt_emails differ from alt_email, log them.
 *   3. If customer has only `alt_email` (singular) → no-op.
 *   4. Final `alt_email` values are lowercased and validated to contain no
 *      whitespace or comma. Violations abort the per-customer update with a
 *      clear error (no silent corruption).
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/consolidate-alt-email-metadata.ts             # dry-run
 *   yarn ts-node src/scripts/fix/consolidate-alt-email-metadata.ts --execute   # apply
 */

import "dotenv/config"
import postgres from "postgres"

const DRY_RUN = !process.argv.includes("--execute")

interface Row {
  id: string
  email: string
  alt_emails_raw: string | null
  alt_email_raw: string | null
}

interface PlanEntry {
  id: string
  email: string
  action:
    | "merge-single"
    | "merge-first-keep-extras-logged"
    | "drop-plural-keep-existing"
    | "skip-no-change"
    | "error-invalid-value"
  before_alt_emails: string | null
  before_alt_email: string | null
  after_alt_email: string | null
  extras?: string[]
  error?: string
}

function cleanCandidate(raw: string): { ok: boolean; value?: string; reason?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: "empty" }
  if (/[\s,]/.test(trimmed)) {
    return { ok: false, reason: "contains whitespace or comma" }
  }
  return { ok: true, value: trimmed.toLowerCase() }
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
      `\n🔍 consolidate-alt-email-metadata — ${DRY_RUN ? "DRY RUN (no changes)" : "⚡ EXECUTE MODE"}\n`
    )

    const rows = await sql<Row[]>`
      SELECT
        id,
        email,
        metadata->>'alt_emails' AS alt_emails_raw,
        metadata->>'alt_email'  AS alt_email_raw
      FROM customer
      WHERE deleted_at IS NULL
        AND (metadata ? 'alt_emails' OR metadata ? 'alt_email')
      ORDER BY id
    `

    console.log(`Found ${rows.length} customers with alt_email metadata to review.`)

    const plan: PlanEntry[] = []

    for (const row of rows) {
      const altEmailsRaw = row.alt_emails_raw
      const altEmailRaw = row.alt_email_raw

      // Case 4: only alt_email exists → no-op (but validate shape)
      if (altEmailsRaw === null && altEmailRaw !== null) {
        const check = cleanCandidate(altEmailRaw)
        if (!check.ok || check.value !== altEmailRaw.toLowerCase()) {
          plan.push({
            id: row.id,
            email: row.email,
            action: "error-invalid-value",
            before_alt_emails: null,
            before_alt_email: altEmailRaw,
            after_alt_email: null,
            error: check.reason ?? "case mismatch",
          })
        } else {
          plan.push({
            id: row.id,
            email: row.email,
            action: "skip-no-change",
            before_alt_emails: null,
            before_alt_email: altEmailRaw,
            after_alt_email: altEmailRaw,
          })
        }
        continue
      }

      // alt_emails (plural) exists
      const parts = (altEmailsRaw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      if (parts.length === 0) {
        // Empty plural: just drop it
        plan.push({
          id: row.id,
          email: row.email,
          action: "drop-plural-keep-existing",
          before_alt_emails: altEmailsRaw,
          before_alt_email: altEmailRaw,
          after_alt_email: altEmailRaw,
        })
        continue
      }

      // Case 2: both exist → keep existing alt_email, just drop plural
      if (altEmailRaw !== null) {
        plan.push({
          id: row.id,
          email: row.email,
          action: "drop-plural-keep-existing",
          before_alt_emails: altEmailsRaw,
          before_alt_email: altEmailRaw,
          after_alt_email: altEmailRaw,
          extras: parts,
        })
        continue
      }

      // Case 1: only plural exists → pick first, clean it, move to singular
      const first = parts[0]
      const check = cleanCandidate(first)
      if (!check.ok) {
        plan.push({
          id: row.id,
          email: row.email,
          action: "error-invalid-value",
          before_alt_emails: altEmailsRaw,
          before_alt_email: null,
          after_alt_email: null,
          error: `first value rejected: ${check.reason}`,
        })
        continue
      }

      const extras = parts.slice(1)
      plan.push({
        id: row.id,
        email: row.email,
        action: extras.length > 0 ? "merge-first-keep-extras-logged" : "merge-single",
        before_alt_emails: altEmailsRaw,
        before_alt_email: null,
        after_alt_email: check.value!,
        extras: extras.length > 0 ? extras : undefined,
      })
    }

    // Summary by action
    const counts: Record<string, number> = {}
    for (const entry of plan) {
      counts[entry.action] = (counts[entry.action] ?? 0) + 1
    }

    console.log(`\n📋 Plan summary:`)
    for (const [action, count] of Object.entries(counts)) {
      console.log(`   ${action}: ${count}`)
    }
    console.log()

    // Log details for merges with extras (user review candidates)
    const mergesWithExtras = plan.filter((p) => p.action === "merge-first-keep-extras-logged")
    if (mergesWithExtras.length > 0) {
      console.log(
        `⚠️  ${mergesWithExtras.length} customer(s) have multiple alt emails — keeping FIRST only:`
      )
      for (const e of mergesWithExtras) {
        console.log(
          `   ${e.id} | email=${e.email} | keep=${e.after_alt_email} | dropping=[${e.extras?.join(", ")}]`
        )
      }
      console.log()
    }

    const conflicts = plan.filter((p) => p.action === "drop-plural-keep-existing" && p.extras)
    if (conflicts.length > 0) {
      console.log(
        `ℹ️  ${conflicts.length} customer(s) had both alt_email AND alt_emails — keeping existing alt_email, dropping plural:`
      )
      for (const e of conflicts) {
        console.log(
          `   ${e.id} | email=${e.email} | keep_alt_email=${e.before_alt_email} | dropped_plural=[${e.extras?.join(", ")}]`
        )
      }
      console.log()
    }

    const errors = plan.filter((p) => p.action === "error-invalid-value")
    if (errors.length > 0) {
      console.log(`❌ ${errors.length} customer(s) have invalid alt email values — NOT touching:`)
      for (const e of errors) {
        console.log(
          `   ${e.id} | email=${e.email} | alt_emails=${e.before_alt_emails} | alt_email=${e.before_alt_email} | reason=${e.error}`
        )
      }
      console.log()
    }

    if (DRY_RUN) {
      console.log(`📋 DRY RUN complete. Re-run with --execute to apply.\n`)
      return
    }

    const toUpdate = plan.filter(
      (p) => p.action !== "skip-no-change" && p.action !== "error-invalid-value"
    )
    console.log(`⚡ Executing ${toUpdate.length} update(s)...`)

    let updated = 0
    await sql.begin(async (trx) => {
      for (const entry of toUpdate) {
        // Build the metadata patch: set alt_email if not already set, always drop alt_emails.
        if (entry.after_alt_email && entry.before_alt_email === null) {
          await trx`
            UPDATE customer
            SET metadata = (metadata - 'alt_emails') || jsonb_build_object('alt_email', ${entry.after_alt_email}::text),
                updated_at = NOW()
            WHERE id = ${entry.id}
              AND deleted_at IS NULL
          `
        } else {
          // Just drop the plural key
          await trx`
            UPDATE customer
            SET metadata = metadata - 'alt_emails',
                updated_at = NOW()
            WHERE id = ${entry.id}
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
