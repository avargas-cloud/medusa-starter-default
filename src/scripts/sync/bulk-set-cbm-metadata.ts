/**
 * src/scripts/sync/bulk-set-cbm-metadata.ts
 *
 * Reads cbm-catalog.json (SKU → CBM/unit) and sets
 * metadata.cbm on every matching product_variant.
 *
 * Usage (dry-run):
 *   npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-cbm-metadata.ts
 *
 * Usage (apply):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-cbm-metadata.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'
import { Client } from 'pg'

dotenv.config()

const CBM_FILE = path.join(__dirname, 'cbm-catalog.json')
const APPLY = process.env.APPLY === 'true'

async function main() {
  const cbmMap: Record<string, number> = JSON.parse(fs.readFileSync(CBM_FILE, 'utf8'))
  const skus = Object.keys(cbmMap)
  console.log(`Loaded ${skus.length} SKUs from cbm-catalog.json`)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // Fetch all variants whose SKU is in the catalog
    const res = await client.query<{ id: string; sku: string; metadata: Record<string, unknown> | null }>(
      `SELECT id, sku, metadata
         FROM product_variant
        WHERE sku = ANY($1::text[])
          AND deleted_at IS NULL`,
      [skus]
    )

    const rows = res.rows
    console.log(`\nFound ${rows.length} variants matching catalog SKUs`)

    const missing = skus.filter((s) => !rows.some((r) => r.sku === s))
    if (missing.length > 0) {
      console.log(`\nSKUs in catalog but NOT in DB (${missing.length}):`)
      missing.forEach((s) => console.log(`  - ${s}  (cbm=${cbmMap[s]})`))
    }

    let updated = 0
    let unchanged = 0

    for (const row of rows) {
      const newCbm = cbmMap[row.sku]
      const currentCbm = (row.metadata ?? {})['cbm']

      if (currentCbm === newCbm) {
        unchanged++
        continue
      }

      console.log(
        `  ${APPLY ? 'UPDATE' : '[dry]'} ${row.sku}: cbm ${currentCbm ?? 'null'} → ${newCbm}`
      )

      if (APPLY) {
        await client.query(
          `UPDATE product_variant
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cbm', $1::float),
                  updated_at = NOW()
            WHERE id = $2`,
          [newCbm, row.id]
        )
      }
      updated++
    }

    console.log(
      `\nDone. ${APPLY ? 'Updated' : 'Would update'}: ${updated} | Unchanged: ${unchanged} | Missing from DB: ${missing.length}`
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
