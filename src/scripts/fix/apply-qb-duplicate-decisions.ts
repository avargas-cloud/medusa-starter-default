/**
 * apply-qb-duplicate-decisions.ts
 *
 * Reads QB_Customer_Email_Fix_DONE.xlsx and applies the human-made decisions
 * for the 20 QB-conflict customer groups that normalize-customer-emails.ts
 * left untouched.
 *
 * For each group (2 rows — one marked YES in the __EMPTY column):
 *   • MAIN (YES)      → email = LOWER(email) if it has uppercase chars
 *   • SECONDARY (not) → metadata.alt_email = <real email, lowercased>
 *                       metadata.email_is_placeholder = true
 *                       email = noemail-{cus_id_suffix}@ecopowertech.com
 *
 * The dummy email pattern is deterministic (derived from the customer's own
 * ULID) so this script is idempotent — re-running on an already-processed
 * secondary detects `email_is_placeholder: true` and skips.
 *
 * Usage:
 *   yarn ts-node src/scripts/fix/apply-qb-duplicate-decisions.ts             # dry-run
 *   yarn ts-node src/scripts/fix/apply-qb-duplicate-decisions.ts --execute   # apply
 */

import "dotenv/config"
import postgres from "postgres"
import * as XLSX from "xlsx"
import path from "path"

const DRY_RUN = !process.argv.includes("--execute")
const XLSX_PATH = path.resolve(
  __dirname,
  "../../../../QB_Customer_Email_Fix_DONE.xlsx"
)

interface XlsxRow {
  __EMPTY?: string
  "Normalized Email"?: string
  "Customer ID"?: string
  "Email (stored)"?: string
  "First Name"?: string
  "Last Name"?: string
  "Legacy QB"?: string
  [key: string]: unknown
}

interface GroupCustomer {
  id: string
  email: string
  isMain: boolean
}

interface ParsedGroup {
  normalizedEmail: string
  main: GroupCustomer
  secondary: GroupCustomer
}

interface CustomerRow {
  id: string
  email: string
  metadata: Record<string, unknown> | null
}

interface PlanAction {
  kind: "dummy-secondary" | "lowercase-main" | "skip-secondary-already-dummy" | "skip-main-already-lowercase"
  customerId: string
  before: string
  after: string
  altEmailBefore?: string | null
  altEmailAfter?: string | null
}

function cusIdSuffix(id: string): string {
  // Strip the 'cus_' prefix if present. ULID suffix is safe for emails.
  return id.startsWith("cus_") ? id.slice(4) : id
}

function dummyEmailFor(customerId: string): string {
  return `noemail-${cusIdSuffix(customerId)}@ecopowertech.com`.toLowerCase()
}

function validateAltEmail(raw: string): { ok: boolean; value?: string; reason?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: "empty" }
  if (/[\s,]/.test(trimmed)) {
    return { ok: false, reason: "contains whitespace or comma" }
  }
  return { ok: true, value: trimmed.toLowerCase() }
}

function parseXlsx(filePath: string): ParsedGroup[] {
  const wb = XLSX.readFile(filePath)
  const sheetName = wb.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json<XlsxRow>(wb.Sheets[sheetName], {
    defval: "",
  })

  const groups: ParsedGroup[] = []
  // Group rows by normalized email, ignoring separator rows (those have empty Customer ID)
  const byEmail = new Map<string, Array<{ row: XlsxRow; isMain: boolean }>>()

  for (const row of rows) {
    const normalized = (row["Normalized Email"] ?? "").toString().trim()
    const customerId = (row["Customer ID"] ?? "").toString().trim()
    if (!normalized || !customerId) continue // skip separator rows
    const marker = (row["__EMPTY"] ?? "").toString().trim().toUpperCase()
    const isMain = marker === "YES"
    if (!byEmail.has(normalized)) byEmail.set(normalized, [])
    byEmail.get(normalized)!.push({ row, isMain })
  }

  for (const [normalizedEmail, entries] of byEmail.entries()) {
    if (entries.length !== 2) {
      throw new Error(
        `Group ${normalizedEmail} has ${entries.length} customers, expected exactly 2`
      )
    }
    const mains = entries.filter((e) => e.isMain)
    if (mains.length !== 1) {
      throw new Error(
        `Group ${normalizedEmail} has ${mains.length} YES-marked rows, expected exactly 1`
      )
    }
    const mainEntry = mains[0]
    const secondaryEntry = entries.find((e) => !e.isMain)!

    groups.push({
      normalizedEmail,
      main: {
        id: String(mainEntry.row["Customer ID"]),
        email: String(mainEntry.row["Email (stored)"] ?? ""),
        isMain: true,
      },
      secondary: {
        id: String(secondaryEntry.row["Customer ID"]),
        email: String(secondaryEntry.row["Email (stored)"] ?? ""),
        isMain: false,
      },
    })
  }

  return groups
}

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set")
    process.exit(1)
  }

  console.log(
    `\n🔍 apply-qb-duplicate-decisions — ${DRY_RUN ? "DRY RUN (no changes)" : "⚡ EXECUTE MODE"}\n`
  )
  console.log(`Reading: ${XLSX_PATH}`)

  const groups = parseXlsx(XLSX_PATH)
  console.log(`Parsed ${groups.length} group(s) from Excel.\n`)

  const sql = postgres(DATABASE_URL)
  try {
    // 1. Load current DB state for each customer in every group
    const allIds = groups.flatMap((g) => [g.main.id, g.secondary.id])
    const dbRows = await sql<CustomerRow[]>`
      SELECT id, email, metadata
      FROM customer
      WHERE id IN ${sql(allIds)}
        AND deleted_at IS NULL
    `
    const dbByIdNonNullable = new Map(dbRows.map((r) => [r.id, r]))

    // 2. Build plan
    interface GroupPlan {
      normalizedEmail: string
      actions: PlanAction[]
      skip?: string
    }
    const plans: GroupPlan[] = []

    for (const group of groups) {
      const main = dbByIdNonNullable.get(group.main.id)
      const secondary = dbByIdNonNullable.get(group.secondary.id)

      if (!main || !secondary) {
        plans.push({
          normalizedEmail: group.normalizedEmail,
          actions: [],
          skip: `missing DB row(s): main=${!!main} secondary=${!!secondary}`,
        })
        continue
      }

      const actions: PlanAction[] = []

      // Secondary: check if already processed
      const secMeta = secondary.metadata ?? {}
      const alreadyPlaceholder = secMeta.email_is_placeholder === true

      if (alreadyPlaceholder) {
        actions.push({
          kind: "skip-secondary-already-dummy",
          customerId: secondary.id,
          before: secondary.email,
          after: secondary.email,
        })
      } else {
        const realEmail = secondary.email
        const check = validateAltEmail(realEmail)
        if (!check.ok) {
          plans.push({
            normalizedEmail: group.normalizedEmail,
            actions: [],
            skip: `secondary ${secondary.id} email=${realEmail} rejected: ${check.reason}`,
          })
          continue
        }
        const dummy = dummyEmailFor(secondary.id)
        actions.push({
          kind: "dummy-secondary",
          customerId: secondary.id,
          before: realEmail,
          after: dummy,
          altEmailBefore: (secMeta.alt_email as string | undefined) ?? null,
          altEmailAfter: check.value!,
        })
      }

      // Main: lowercase if needed
      if (/[A-Z]/.test(main.email)) {
        actions.push({
          kind: "lowercase-main",
          customerId: main.id,
          before: main.email,
          after: main.email.toLowerCase(),
        })
      } else {
        actions.push({
          kind: "skip-main-already-lowercase",
          customerId: main.id,
          before: main.email,
          after: main.email,
        })
      }

      plans.push({ normalizedEmail: group.normalizedEmail, actions })
    }

    // 3. Print plan
    let totalSecondaryUpdates = 0
    let totalMainUpdates = 0
    let totalSkips = 0
    let totalErrors = 0

    for (const plan of plans) {
      console.log(`━━ ${plan.normalizedEmail}`)
      if (plan.skip) {
        console.log(`   ❌ SKIP GROUP: ${plan.skip}`)
        totalErrors++
        continue
      }
      for (const a of plan.actions) {
        switch (a.kind) {
          case "dummy-secondary":
            console.log(`   SECONDARY ${a.customerId}`)
            console.log(`     email:     ${a.before}  →  ${a.after}`)
            console.log(
              `     alt_email: ${a.altEmailBefore ?? "(none)"}  →  ${a.altEmailAfter}`
            )
            console.log(`     email_is_placeholder: false  →  true`)
            totalSecondaryUpdates++
            break
          case "lowercase-main":
            console.log(`   MAIN      ${a.customerId}`)
            console.log(`     email: ${a.before}  →  ${a.after}`)
            totalMainUpdates++
            break
          case "skip-secondary-already-dummy":
            console.log(`   SECONDARY ${a.customerId} — already dummy, skip`)
            totalSkips++
            break
          case "skip-main-already-lowercase":
            console.log(`   MAIN      ${a.customerId} — already lowercase, skip`)
            totalSkips++
            break
        }
      }
      console.log()
    }

    console.log(`📋 Plan totals:`)
    console.log(`   Secondary updates (dummy + alt_email) : ${totalSecondaryUpdates}`)
    console.log(`   Main updates      (lowercase)         : ${totalMainUpdates}`)
    console.log(`   Skipped (idempotent)                  : ${totalSkips}`)
    console.log(`   Errors / malformed groups             : ${totalErrors}`)
    console.log()

    if (totalErrors > 0) {
      console.log(`❌ Aborting because of ${totalErrors} malformed group(s). Fix the Excel and re-run.`)
      return
    }

    if (DRY_RUN) {
      console.log(`📋 DRY RUN complete. Re-run with --execute to apply.\n`)
      return
    }

    console.log(`⚡ Executing updates in a single transaction...\n`)

    await sql.begin(async (trx) => {
      for (const plan of plans) {
        for (const a of plan.actions) {
          if (a.kind === "dummy-secondary") {
            // Merge metadata: set alt_email + email_is_placeholder, preserve everything else.
            // Intentionally drop the legacy 'alt_emails' (plural) key if present on this row.
            await trx`
              UPDATE customer
              SET email = ${a.after},
                  metadata = (metadata - 'alt_emails') || jsonb_build_object(
                    'alt_email', ${a.altEmailAfter!}::text,
                    'email_is_placeholder', true
                  ),
                  updated_at = NOW()
              WHERE id = ${a.customerId}
                AND deleted_at IS NULL
            `
          } else if (a.kind === "lowercase-main") {
            await trx`
              UPDATE customer
              SET email = ${a.after}, updated_at = NOW()
              WHERE id = ${a.customerId}
                AND deleted_at IS NULL
                AND email = ${a.before}
            `
          }
        }
      }
    })

    console.log(`✅ Done.`)
    console.log(`   Secondary customers dummified : ${totalSecondaryUpdates}`)
    console.log(`   Main customers lowercased     : ${totalMainUpdates}`)
  } finally {
    await sql.end()
  }
}

run().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
