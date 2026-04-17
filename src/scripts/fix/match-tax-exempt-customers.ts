/**
 * match-tax-exempt-customers.ts
 *
 * Phase 1 of the QB tax-exempt migration.
 *
 * Reads `customer no tax.xlsx` from the repo root (Sheet4, 564 rows),
 * matches each QB customer against the Medusa `customer` table using a
 * 7-strategy cascade, and writes a report workbook with three sheets:
 *   - Matches:   rows where exactly one Medusa customer was found
 *   - Unmatched: rows where no strategy hit
 *   - Ambiguous: rows whose match key was non-unique in the DB
 *
 * No DB writes. Run this first, review the report, then use
 * apply-tax-exempt-metadata.ts to commit the changes.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/match-tax-exempt-customers.ts
 */

import "dotenv/config"
import path from "path"
import XLSX from "xlsx"
import postgres from "postgres"

const REPO_ROOT = path.resolve(__dirname, "../../../../")
const INPUT_XLSX = path.join(REPO_ROOT, "customer no tax.xlsx")
const OUTPUT_XLSX = path.join(
  REPO_ROOT,
  `match_tax_exempt_report_${new Date().toISOString().slice(0, 10)}.xlsx`
)
const INPUT_SHEET = "Sheet4"

/**
 * Emails in the Excel that are malformed but whose intended target is known.
 * Extend here if more typos surface during review.
 */
const EMAIL_TYPO_FIXES: Record<string, string> = {
  "jorgemelocyahoo.com": "jorgemelo@yahoo.com",
}

interface QbRow {
  rowIndex: number
  customer: string
  company: string
  firstName: string
  lastName: string
  email: string
  phone: string
  salesTaxCode: string
  taxItem: string
  resaleNum: string
}

type MatchStrategy =
  | "email_primary"
  | "email_alt"
  | "email_qb_original"
  | "company_from_customer_col"
  | "company_from_company_col"
  | "fullname_from_customer_col"
  | "firstlast_split_cols"

interface MatchedRow extends QbRow {
  customerId: string
  currentEmail: string | null
  strategy: MatchStrategy
}

interface AmbiguousRow extends QbRow {
  conflict: string
  candidateCount: number
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toLowerCase()

function readExcel(): QbRow[] {
  const wb = XLSX.readFile(INPUT_XLSX)
  if (!wb.SheetNames.includes(INPUT_SHEET)) {
    throw new Error(
      `Sheet '${INPUT_SHEET}' not found. Available: ${wb.SheetNames.join(", ")}`
    )
  }
  const ws = wb.Sheets[INPUT_SHEET]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
    raw: false,
  })
  return raw.map((r, i) => ({
    rowIndex: i + 2, // +1 for header, +1 for 1-based Excel rows
    customer: String(r["Customer"] ?? "").trim(),
    company: String(r["Company"] ?? "").trim(),
    firstName: String(r["First Name"] ?? "").trim(),
    lastName: String(r["Last Name"] ?? "").trim(),
    email: String(r["Email"] ?? "").trim(),
    phone: String(r["Phone"] ?? "").trim(),
    salesTaxCode: String(r["Sales Tax Code"] ?? "").trim(),
    taxItem: String(r["Tax item"] ?? "").trim(),
    resaleNum: String(r["Resale Num"] ?? "").trim(),
  }))
}

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set")
    process.exit(1)
  }

  console.log("\n🔍 match-tax-exempt-customers — READ-ONLY report\n")
  console.log(`📥 Input:  ${INPUT_XLSX}`)
  console.log(`📤 Output: ${OUTPUT_XLSX}\n`)

  const qbRows = readExcel()
  console.log(`Loaded ${qbRows.length} rows from Excel.`)

  // Apply typo corrections to emails before matching
  let typoCount = 0
  for (const r of qbRows) {
    const lower = r.email.toLowerCase()
    if (EMAIL_TYPO_FIXES[lower]) {
      r.email = EMAIL_TYPO_FIXES[lower]
      typoCount++
    }
  }
  if (typoCount > 0) {
    console.log(`Applied ${typoCount} email typo correction(s).`)
  }

  const sql = postgres(DATABASE_URL)
  try {
    // Pre-compute sets of duplicate normalized keys in the DB so the
    // company/name strategies never pick arbitrarily when ambiguous.
    console.log("Scanning DB for duplicate company/name keys...")
    const dupCompanies = new Set<string>(
      (
        await sql<{ k: string }[]>`
          SELECT LOWER(TRIM(company_name)) AS k
          FROM customer
          WHERE deleted_at IS NULL
            AND company_name IS NOT NULL
            AND TRIM(company_name) <> ''
          GROUP BY 1
          HAVING COUNT(*) > 1
        `
      ).map((r) => r.k)
    )
    const dupFullNames = new Set<string>(
      (
        await sql<{ k: string }[]>`
          SELECT LOWER(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))) AS k
          FROM customer
          WHERE deleted_at IS NULL
            AND (first_name IS NOT NULL OR last_name IS NOT NULL)
          GROUP BY 1
          HAVING COUNT(*) > 1
        `
      ).map((r) => r.k)
    )
    const dupFirstLast = new Set<string>(
      (
        await sql<{ k: string }[]>`
          SELECT LOWER(TRIM(first_name)) || '|' || LOWER(TRIM(last_name)) AS k
          FROM customer
          WHERE deleted_at IS NULL
            AND first_name IS NOT NULL AND last_name IS NOT NULL
            AND TRIM(first_name) <> '' AND TRIM(last_name) <> ''
          GROUP BY 1
          HAVING COUNT(*) > 1
        `
      ).map((r) => r.k)
    )
    console.log(
      `  Duplicate company_name keys: ${dupCompanies.size}, fullname keys: ${dupFullNames.size}, firstlast keys: ${dupFirstLast.size}`
    )

    const matches: MatchedRow[] = []
    const unmatched: QbRow[] = []
    const ambiguous: AmbiguousRow[] = []
    const matchedCustomerIds = new Set<string>()

    const strategyCounts: Record<MatchStrategy, number> = {
      email_primary: 0,
      email_alt: 0,
      email_qb_original: 0,
      company_from_customer_col: 0,
      company_from_company_col: 0,
      fullname_from_customer_col: 0,
      firstlast_split_cols: 0,
    }

    for (const row of qbRows) {
      const emailNorm = norm(row.email)

      // Strategy 1-3: email variants
      if (emailNorm) {
        const candidates = await sql<
          { id: string; email: string | null; via: string }[]
        >`
          SELECT id, email, 'primary' AS via FROM customer
            WHERE deleted_at IS NULL AND LOWER(email) = ${emailNorm}
          UNION ALL
          SELECT id, email, 'alt' AS via FROM customer
            WHERE deleted_at IS NULL AND LOWER(metadata->>'alt_email') = ${emailNorm}
          UNION ALL
          SELECT id, email, 'qb_original' AS via FROM customer
            WHERE deleted_at IS NULL AND LOWER(metadata->>'qb_original_email') = ${emailNorm}
        `
        if (candidates.length > 0) {
          // Prefer primary → alt → qb_original; dedupe by id
          const order = ["primary", "alt", "qb_original"]
          candidates.sort(
            (a, b) => order.indexOf(a.via) - order.indexOf(b.via)
          )
          const uniqueIds = Array.from(new Set(candidates.map((c) => c.id)))
          if (uniqueIds.length === 1) {
            const hit = candidates.find((c) => c.id === uniqueIds[0])!
            const strategy =
              hit.via === "primary"
                ? "email_primary"
                : hit.via === "alt"
                ? "email_alt"
                : "email_qb_original"
            strategyCounts[strategy]++
            matches.push({
              ...row,
              customerId: hit.id,
              currentEmail: hit.email,
              strategy,
            })
            matchedCustomerIds.add(hit.id)
            continue
          } else {
            ambiguous.push({
              ...row,
              conflict: `email matched ${uniqueIds.length} customers`,
              candidateCount: uniqueIds.length,
            })
            continue
          }
        }
      }

      // Strategy 4: company_name = row.Customer
      const custNorm = norm(row.customer)
      if (custNorm) {
        if (dupCompanies.has(custNorm)) {
          const count = await countCompany(sql, custNorm)
          ambiguous.push({
            ...row,
            conflict: `company_name "${row.customer}" is not unique`,
            candidateCount: count,
          })
          continue
        }
        const hit = await sql<{ id: string; email: string | null }[]>`
          SELECT id, email FROM customer
          WHERE deleted_at IS NULL AND LOWER(company_name) = ${custNorm}
          LIMIT 1
        `
        if (hit.length === 1 && !matchedCustomerIds.has(hit[0].id)) {
          strategyCounts.company_from_customer_col++
          matches.push({
            ...row,
            customerId: hit[0].id,
            currentEmail: hit[0].email,
            strategy: "company_from_customer_col",
          })
          matchedCustomerIds.add(hit[0].id)
          continue
        }
      }

      // Strategy 5: company_name = row.Company
      const compNorm = norm(row.company)
      if (compNorm && compNorm !== custNorm) {
        if (dupCompanies.has(compNorm)) {
          const count = await countCompany(sql, compNorm)
          ambiguous.push({
            ...row,
            conflict: `company "${row.company}" is not unique`,
            candidateCount: count,
          })
          continue
        }
        const hit = await sql<{ id: string; email: string | null }[]>`
          SELECT id, email FROM customer
          WHERE deleted_at IS NULL AND LOWER(company_name) = ${compNorm}
          LIMIT 1
        `
        if (hit.length === 1 && !matchedCustomerIds.has(hit[0].id)) {
          strategyCounts.company_from_company_col++
          matches.push({
            ...row,
            customerId: hit[0].id,
            currentEmail: hit[0].email,
            strategy: "company_from_company_col",
          })
          matchedCustomerIds.add(hit[0].id)
          continue
        }
      }

      // Strategy 6: first_name || ' ' || last_name = row.Customer
      if (custNorm) {
        if (dupFullNames.has(custNorm)) {
          ambiguous.push({
            ...row,
            conflict: `fullname "${row.customer}" is not unique`,
            candidateCount: 0,
          })
          continue
        }
        const hit = await sql<{ id: string; email: string | null }[]>`
          SELECT id, email FROM customer
          WHERE deleted_at IS NULL
            AND LOWER(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))) = ${custNorm}
          LIMIT 1
        `
        if (hit.length === 1 && !matchedCustomerIds.has(hit[0].id)) {
          strategyCounts.fullname_from_customer_col++
          matches.push({
            ...row,
            customerId: hit[0].id,
            currentEmail: hit[0].email,
            strategy: "fullname_from_customer_col",
          })
          matchedCustomerIds.add(hit[0].id)
          continue
        }
      }

      // Strategy 7: first_name = row.FirstName AND last_name = row.LastName
      const fnNorm = norm(row.firstName)
      const lnNorm = norm(row.lastName)
      if (fnNorm && lnNorm) {
        const key = `${fnNorm}|${lnNorm}`
        if (dupFirstLast.has(key)) {
          ambiguous.push({
            ...row,
            conflict: `first+last "${row.firstName} ${row.lastName}" is not unique`,
            candidateCount: 0,
          })
          continue
        }
        const hit = await sql<{ id: string; email: string | null }[]>`
          SELECT id, email FROM customer
          WHERE deleted_at IS NULL
            AND LOWER(first_name) = ${fnNorm}
            AND LOWER(last_name)  = ${lnNorm}
          LIMIT 1
        `
        if (hit.length === 1 && !matchedCustomerIds.has(hit[0].id)) {
          strategyCounts.firstlast_split_cols++
          matches.push({
            ...row,
            customerId: hit[0].id,
            currentEmail: hit[0].email,
            strategy: "firstlast_split_cols",
          })
          matchedCustomerIds.add(hit[0].id)
          continue
        }
      }

      unmatched.push(row)
    }

    // ── Report ──
    console.log("\n=== Match summary ===")
    console.log(
      `Total rows:      ${qbRows.length}`
    )
    console.log(`Matched:         ${matches.length}`)
    for (const k of Object.keys(strategyCounts) as MatchStrategy[]) {
      console.log(`  ${k.padEnd(28)} ${strategyCounts[k]}`)
    }
    console.log(`Ambiguous:       ${ambiguous.length}`)
    console.log(`Unmatched:       ${unmatched.length}`)
    console.log(
      `Unique Medusa customers flagged: ${matchedCustomerIds.size}`
    )

    writeReport(matches, unmatched, ambiguous)
    console.log(`\n✅ Report written to ${OUTPUT_XLSX}`)
  } finally {
    await sql.end()
  }
}

async function countCompany(
  sql: postgres.Sql,
  compNorm: string
): Promise<number> {
  const r = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM customer
    WHERE deleted_at IS NULL AND LOWER(company_name) = ${compNorm}
  `
  return Number(r[0]?.c ?? 0)
}

function writeReport(
  matches: MatchedRow[],
  unmatched: QbRow[],
  ambiguous: AmbiguousRow[]
) {
  const wb = XLSX.utils.book_new()

  const matchesRows = matches.map((m) => ({
    excel_row: m.rowIndex,
    customer_id: m.customerId,
    match_strategy: m.strategy,
    qb_customer: m.customer,
    qb_company: m.company,
    qb_email: m.email,
    current_medusa_email: m.currentEmail ?? "",
    qb_tax_item: m.taxItem,
    qb_sales_tax_code: m.salesTaxCode,
    qb_resale_num: m.resaleNum,
    qb_phone: m.phone,
  }))

  const unmatchedRows = unmatched.map((m) => ({
    excel_row: m.rowIndex,
    qb_customer: m.customer,
    qb_company: m.company,
    qb_first_name: m.firstName,
    qb_last_name: m.lastName,
    qb_email: m.email,
    qb_phone: m.phone,
    qb_tax_item: m.taxItem,
    qb_resale_num: m.resaleNum,
  }))

  const ambiguousRows = ambiguous.map((m) => ({
    excel_row: m.rowIndex,
    conflict: m.conflict,
    candidate_count: m.candidateCount,
    qb_customer: m.customer,
    qb_company: m.company,
    qb_email: m.email,
    qb_tax_item: m.taxItem,
  }))

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(matchesRows),
    "Matches"
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(unmatchedRows),
    "Unmatched"
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(ambiguousRows),
    "Ambiguous"
  )

  XLSX.writeFile(wb, OUTPUT_XLSX)
}

run().catch((err) => {
  console.error("❌ Error:", err)
  process.exit(1)
})
