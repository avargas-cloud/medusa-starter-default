#!/usr/bin/env tsx
/**
 * fix-line-item-sales-description.ts
 *
 * Backfills `sales_description` into the metadata of existing order line items
 * by joining order_line_item → product_variant → product.
 *
 * Safe: only updates items where:
 *   1. The product HAS a sales_description in its metadata.
 *   2. The line item does NOT already have sales_description set.
 *
 * Run with:
 *   cd backend && npx -y tsx src/scripts/fix/fix-line-item-sales-description.ts
 */

import { Client } from 'pg'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log('✅ Connected to database\n')

    // 1. Preview — how many items need backfill
    const countRes = await client.query(`
    SELECT COUNT(*) as total
    FROM order_line_item oli
    JOIN product_variant pv ON oli.variant_id = pv.id
    JOIN product p ON pv.product_id = p.id
    WHERE p.metadata->>'sales_description' IS NOT NULL
      AND p.metadata->>'sales_description' != ''
      AND (oli.metadata IS NULL OR oli.metadata->>'sales_description' IS NULL)
  `)
    const total = parseInt(countRes.rows[0].total, 10)
    console.log(`📦 Line items that need sales_description backfill: ${total}`)

    if (total === 0) {
        console.log('✅ Nothing to update — all items already have sales_description.')
        await client.end()
        return
    }

    // 2. Execute backfill
    const updateRes = await client.query(`
    UPDATE order_line_item oli
    SET metadata = COALESCE(oli.metadata, '{}'::jsonb)
                  || jsonb_build_object('sales_description', p.metadata->>'sales_description')
    FROM product_variant pv
    JOIN product p ON pv.product_id = p.id
    WHERE oli.variant_id = pv.id
      AND p.metadata->>'sales_description' IS NOT NULL
      AND p.metadata->>'sales_description' != ''
      AND (oli.metadata IS NULL OR oli.metadata->>'sales_description' IS NULL)
  `)
    console.log(`✅ Updated ${updateRes.rowCount} line items with sales_description.\n`)

    // 3. Spot-check: show a few updated items
    const sampleRes = await client.query(`
    SELECT oli.id, oli.title, oli.metadata->>'sales_description' as sales_description
    FROM order_line_item oli
    WHERE oli.metadata->>'sales_description' IS NOT NULL
    ORDER BY oli.created_at DESC
    LIMIT 5
  `)
    console.log('Sample updated items:')
    for (const row of sampleRes.rows) {
        console.log(`  [${row.id}] ${row.title}`)
        console.log(`    → ${row.sales_description?.substring(0, 80)}...`)
    }

    await client.end()
    console.log('\n✅ Done.')
}

main().catch(err => {
    console.error('❌ Error:', err)
    process.exit(1)
})
