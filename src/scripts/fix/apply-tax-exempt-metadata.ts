/**
 * apply-tax-exempt-metadata.ts
 *
 * Phase 2 of the QB tax-exempt migration.
 *
 * Reads the latest `match_tax_exempt_report_*.xlsx` (Matches sheet) at the
 * repo root and applies the following inside a single transaction:
 *   1. Ensure the `tax-exempt` customer_group exists.
 *   2. Snapshot current metadata + group membership for every touched
 *      customer to a rollback JSON file.
 *   3. Set metadata.default_tax='exempt' (+ reason, resale_num, source)
 *      for every matched customer whose current value isn't already 'exempt'.
 *   4. Link every matched customer to the `tax-exempt` group (skipping
 *      existing links).
 *   5. Backfill metadata.default_tax='florida' for all other active
 *      customers whose default_tax is currently NULL. Never overwrites.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/apply-tax-exempt-metadata.ts            # dry-run
 *   yarn ts-node src/scripts/fix/apply-tax-exempt-metadata.ts --execute  # apply
 */

import "dotenv/config"
import fs from "fs"
import path from "path"
import XLSX from "xlsx"
import postgres from "postgres"
import { ulid } from "ulid"

const DRY_RUN = !process.argv.includes("--execute")
const REPO_ROOT = path.resolve(__dirname, "../../../../")
const GROUP_NAME = "tax-exempt"
const SOURCE_TAG = "qb_import_2026-04-17"

function latestMatchReport(): string {
  const files = fs
    .readdirSync(REPO_ROOT)
    .filter((f) => /^match_tax_exempt_report_.+\.xlsx$/.test(f))
    .sort()
  if (files.length === 0) {
    throw new Error(
      `No match_tax_exempt_report_*.xlsx found at ${REPO_ROOT}. Run match-tax-exempt-customers.ts first.`
    )
  }
  return path.join(REPO_ROOT, files[files.length - 1])
}

interface MatchRow {
  customer_id: string
  qb_tax_item: string
  qb_resale_num: string
  qb_customer: string
  match_strategy: string
}

function readMatches(reportPath: string): MatchRow[] {
  const wb = XLSX.readFile(reportPath)
  const ws = wb.Sheets["Matches"]
  if (!ws) throw new Error("Sheet 'Matches' missing from report")
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
  })
  return rows.map((r) => ({
    customer_id: String(r["customer_id"] ?? "").trim(),
    qb_tax_item: String(r["qb_tax_item"] ?? "").trim(),
    qb_resale_num: String(r["qb_resale_num"] ?? "").trim(),
    qb_customer: String(r["qb_customer"] ?? "").trim(),
    match_strategy: String(r["match_strategy"] ?? "").trim(),
  }))
}

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set")
    process.exit(1)
  }

  const reportPath = latestMatchReport()
  console.log(
    `\n⚙️  apply-tax-exempt-metadata — ${DRY_RUN ? "DRY RUN (no writes)" : "⚡ EXECUTE MODE"}`
  )
  console.log(`📥 Reading matches from ${reportPath}\n`)

  const matches = readMatches(reportPath)
  console.log(`Matches in report: ${matches.length}`)

  // Collapse to unique customer ids. If the same id appears twice with
  // conflicting tax_items, we keep the first occurrence (they should still
  // both resolve to 0% tax regardless of reason).
  const uniqueMatches = new Map<string, MatchRow>()
  for (const m of matches) {
    if (!m.customer_id) continue
    if (!uniqueMatches.has(m.customer_id)) {
      uniqueMatches.set(m.customer_id, m)
    }
  }
  console.log(`Unique matched customer_ids: ${uniqueMatches.size}`)

  const sql = postgres(DATABASE_URL)
  try {
    await sql.begin(async (tx) => {
      // 1. Ensure customer_group 'tax-exempt' exists.
      const existingGroup = await tx<{ id: string }[]>`
        SELECT id FROM customer_group
        WHERE name = ${GROUP_NAME} AND deleted_at IS NULL
        LIMIT 1
      `
      let groupId: string
      if (existingGroup.length === 0) {
        groupId = `cusgroup_${ulid()}`
        console.log(`No '${GROUP_NAME}' group found. Will create id=${groupId}`)
        if (!DRY_RUN) {
          await tx`
            INSERT INTO customer_group (id, name, created_at, updated_at)
            VALUES (${groupId}, ${GROUP_NAME}, NOW(), NOW())
          `
        }
      } else {
        groupId = existingGroup[0].id
        console.log(`'${GROUP_NAME}' group already exists: ${groupId}`)
      }

      // 2. Snapshot rollback data.
      const customerIds = Array.from(uniqueMatches.keys())
      const existing = await tx<
        { id: string; metadata: unknown }[]
      >`
        SELECT id, metadata FROM customer WHERE id IN ${tx(customerIds)}
      `
      const existingLinks = await tx<
        { customer_id: string; customer_group_id: string; id: string }[]
      >`
        SELECT id, customer_id, customer_group_id
        FROM customer_group_customer
        WHERE customer_id IN ${tx(customerIds)}
          AND deleted_at IS NULL
      `
      const rollback = {
        timestamp: new Date().toISOString(),
        group_id_used: groupId,
        group_created_new: existingGroup.length === 0,
        customers: existing,
        existing_links: existingLinks,
      }
      const rollbackPath = path.join(
        REPO_ROOT,
        `rollback_tax_exempt_${Date.now()}.json`
      )
      if (!DRY_RUN) {
        fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2))
        console.log(`💾 Rollback snapshot written to ${rollbackPath}`)
      } else {
        console.log(`(dry-run) Rollback snapshot would be at ${rollbackPath}`)
      }

      // 3. Update matched customers' metadata (skip if already exempt).
      let metaUpdates = 0
      let metaSkipped = 0
      for (const [cid, m] of uniqueMatches) {
        if (DRY_RUN) {
          metaUpdates++
          continue
        }
        const reason = m.qb_tax_item || ""
        const resale = m.qb_resale_num || ""
        const res = await tx`
          UPDATE customer
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'default_tax', 'exempt'::text,
            'tax_exempt_reason', ${reason}::text,
            'tax_exempt_resale_num', ${resale}::text,
            'tax_exempt_source', ${SOURCE_TAG}::text
          ),
              updated_at = NOW()
          WHERE id = ${cid}
            AND deleted_at IS NULL
            AND (metadata->>'default_tax' IS DISTINCT FROM 'exempt'
                 OR metadata->>'tax_exempt_source' IS DISTINCT FROM ${SOURCE_TAG}::text)
        `
        if (res.count > 0) metaUpdates++
        else metaSkipped++
      }
      console.log(
        `Metadata updates — updated: ${metaUpdates}, skipped (already set): ${metaSkipped}`
      )

      // 4. Link matched customers to the tax-exempt group.
      const existingLinkSet = new Set(
        existingLinks
          .filter((l) => l.customer_group_id === groupId)
          .map((l) => l.customer_id)
      )
      let linkInserts = 0
      for (const cid of customerIds) {
        if (existingLinkSet.has(cid)) continue
        if (DRY_RUN) {
          linkInserts++
          continue
        }
        const linkId = `cusgc_${ulid()}`
        await tx`
          INSERT INTO customer_group_customer
            (id, customer_id, customer_group_id, created_at, updated_at)
          VALUES
            (${linkId}, ${cid}, ${groupId}, NOW(), NOW())
        `
        linkInserts++
      }
      console.log(
        `Group links — to insert: ${linkInserts}, already linked: ${existingLinkSet.size}`
      )

      // 5. Backfill 'florida' for customers without any default_tax set,
      //    excluding the matched set.
      if (DRY_RUN) {
        const count = await tx<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM customer
          WHERE deleted_at IS NULL
            AND (metadata->>'default_tax') IS NULL
            AND id NOT IN ${tx(customerIds)}
        `
        console.log(`(dry-run) Would backfill 'florida' on ${count[0].c} customers`)
      } else {
        const res = await tx`
          UPDATE customer
          SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"default_tax":"florida"}'::jsonb,
              updated_at = NOW()
          WHERE deleted_at IS NULL
            AND (metadata->>'default_tax') IS NULL
            AND id NOT IN ${tx(customerIds)}
        `
        console.log(`Florida backfill — updated: ${res.count}`)
      }

      if (DRY_RUN) {
        console.log("\n🟡 DRY-RUN complete. Re-run with --execute to apply.")
        // Force rollback at end of transaction
        throw new Error("__DRY_RUN_ROLLBACK__")
      }
    })

    console.log("\n✅ Migration committed.")
  } catch (err) {
    if (err instanceof Error && err.message === "__DRY_RUN_ROLLBACK__") {
      // Expected in dry-run mode
    } else {
      throw err
    }
  } finally {
    await sql.end()
  }
}

run().catch((err) => {
  console.error("❌ Error:", err)
  process.exit(1)
})
