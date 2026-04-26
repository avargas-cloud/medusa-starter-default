/**
 * src/scripts/sync/bulk-set-transit-days.ts
 *
 * Sets metadata.transit_days = <DAYS> on every product whose SKU starts with
 * one of the given prefixes. Used to override the global "China → USA" transit
 * time for products that ship differently (e.g. EAP profiles take 15 days).
 *
 * Usage (dry-run):
 *   npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-transit-days.ts
 *
 * Usage (apply):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/sync/bulk-set-transit-days.ts
 *
 * Override defaults:
 *   SKU_PREFIXES=EAP,ECN TRANSIT_DAYS=20 APPLY=true npx ts-node ...
 */

import * as dotenv from 'dotenv'
import { Client } from 'pg'

dotenv.config()

const APPLY = process.env.APPLY === 'true'
const TRANSIT_DAYS = Number(process.env.TRANSIT_DAYS ?? 15)
const SKU_PREFIXES = (process.env.SKU_PREFIXES ?? 'EAP').split(',').map((s) => s.trim()).filter(Boolean)

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  try {
    // Find all products with at least one matching variant
    const prefixConditions = SKU_PREFIXES.map((_, i) => `pv.sku LIKE $${i + 1}`).join(' OR ')
    const params = SKU_PREFIXES.map((p) => `${p}%`)

    const { rows: products } = await db.query<{ id: string; title: string; metadata: Record<string, unknown> }>(
      `SELECT DISTINCT p.id, p.title, p.metadata
       FROM product p
       JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
       WHERE p.deleted_at IS NULL AND (${prefixConditions})
       ORDER BY p.title`,
      params
    )

    console.log(`\nFound ${products.length} products matching prefix(es): ${SKU_PREFIXES.join(', ')}`)
    console.log(`transit_days target: ${TRANSIT_DAYS}`)
    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`)

    const alreadySet = products.filter((p) => p.metadata?.transit_days === TRANSIT_DAYS)
    const toUpdate   = products.filter((p) => p.metadata?.transit_days !== TRANSIT_DAYS)

    console.log(`Already set to ${TRANSIT_DAYS}: ${alreadySet.length}`)
    console.log(`To update: ${toUpdate.length}`)

    if (toUpdate.length > 0) {
      console.log('\nProducts to update:')
      for (const p of toUpdate) {
        const current = p.metadata?.transit_days ?? '(not set)'
        console.log(`  ${p.title}  [current: ${current} → ${TRANSIT_DAYS}]`)
      }
    }

    if (!APPLY) {
      console.log('\n[DRY-RUN] No changes made. Set APPLY=true to apply.')
      return
    }

    if (toUpdate.length === 0) {
      console.log('\nAll products already up to date.')
      return
    }

    const ids = toUpdate.map((p) => p.id)
    const { rowCount } = await db.query(
      `UPDATE product
       SET metadata   = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('transit_days', $1::int),
           updated_at = NOW()
       WHERE id = ANY($2::text[])`,
      [TRANSIT_DAYS, ids]
    )

    console.log(`\n✓ Updated ${rowCount} products with transit_days = ${TRANSIT_DAYS}`)
  } finally {
    await db.end()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
