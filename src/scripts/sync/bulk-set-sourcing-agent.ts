/**
 * src/scripts/sync/bulk-set-sourcing-agent.ts
 *
 * Sets metadata.is_sourced_via_agent = true on every product
 * that has at least one variant whose SKU starts with one of
 * the known agent-sourced prefixes:
 *   ESP, EPS, EAP, ECT, ENE, EMS, ECL, EBU, EMO, EIN
 *
 * Only the `product` table is touched — not `product_variant`.
 * Products already carrying the flag are skipped.
 *
 * Usage (dry-run):
 *   npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-sourcing-agent.ts
 *
 * Usage (apply):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-sourcing-agent.ts
 */

import * as dotenv from 'dotenv'
import { Client } from 'pg'

dotenv.config()

const APPLY = process.env.APPLY === 'true'

const SKU_PREFIXES = ['ESP', 'EPS', 'EAP', 'ECT', 'ENE', 'EMS', 'ECL', 'EBU', 'EMO', 'EIN']

/** Build a WHERE clause that matches SKUs starting with any of the prefixes. */
function buildPrefixConditions(prefixes: string[]): { clause: string; params: string[] } {
  const params = prefixes.map((p) => `${p}%`)
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ')
  const clause = `pv.sku LIKE ANY(ARRAY[${placeholders}])`
  return { clause, params }
}

interface ProductRow {
  id: string
  title: string
  metadata: Record<string, unknown> | null
  sample_sku: string
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`Prefixes: ${SKU_PREFIXES.join(', ')}\n`)

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    const { clause, params } = buildPrefixConditions(SKU_PREFIXES)

    // Find all products that have at least one variant with a matching SKU prefix.
    // Return the product id, title, current metadata, and one sample SKU.
    const matchRes = await client.query<ProductRow>(
      `SELECT DISTINCT ON (p.id)
              p.id,
              p.title,
              p.metadata,
              pv.sku AS sample_sku
         FROM product p
         JOIN product_variant pv ON pv.product_id = p.id
        WHERE ${clause}
          AND pv.deleted_at IS NULL
          AND p.deleted_at   IS NULL
        ORDER BY p.id, pv.sku`,
      params
    )

    const allMatched = matchRes.rows
    console.log(`Matched products (any prefix variant): ${allMatched.length}`)

    const alreadySet = allMatched.filter(
      (r) => (r.metadata ?? {})['is_sourced_via_agent'] === true
    )
    const toUpdate = allMatched.filter(
      (r) => (r.metadata ?? {})['is_sourced_via_agent'] !== true
    )

    console.log(`Already set (is_sourced_via_agent = true): ${alreadySet.length}`)
    console.log(`${APPLY ? 'Will update' : 'Would update'}: ${toUpdate.length}\n`)

    if (toUpdate.length === 0) {
      console.log('Nothing to do.')
      return
    }

    // List every product we are going to touch
    for (const row of toUpdate) {
      const title = row.title.length > 50 ? `${row.title.slice(0, 47)}...` : row.title
      console.log(`  ${APPLY ? 'UPDATE' : '[dry]'} ${row.id}  "${title}"  (sample SKU: ${row.sample_sku})`)
    }

    if (APPLY) {
      const ids = toUpdate.map((r) => r.id)
      await client.query(
        `UPDATE product p
            SET metadata   = COALESCE(metadata, '{}'::jsonb) || '{"is_sourced_via_agent": true}'::jsonb,
                updated_at = NOW()
          WHERE p.id = ANY($1::text[])`,
        [ids]
      )
      console.log(`\nUpdated ${ids.length} product(s).`)
    } else {
      console.log(`\nDry-run complete — no changes written. Re-run with APPLY=true to apply.`)
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
