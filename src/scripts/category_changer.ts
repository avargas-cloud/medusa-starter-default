#!/usr/bin/env tsx
/**
 * category_changer.ts
 *
 * Assigns LED Strip products to the correct Medusa category based on variant SKU patterns.
 *
 * RULES:
 *   - Only processes products that have NO category assigned yet.
 *   - LED Strip detection: at least one variant SKU starts with 'ESP'
 *   - Subcategory is determined by the SUFFIX of the variant SKU (longest match wins)
 *
 * SUFFIX MAPPING (White LED Strip):
 *   27, 27K, 30, 30K, 35, 35K, 40, 40K, 50, 50K, 60, 60K, 70, 70K → White LED Strip
 *
 * SUFFIX MAPPING (Adjustable Color Temperature):
 *   CCT, CT → Adjustable Color Temperature LED Strip
 *
 * SUFFIX MAPPING (RGB):
 *   RGB, RG → RGB LED Strip
 *
 * SUFFIX MAPPING (RGBW):
 *   RGBW, RW → RGBW LED Strip
 *
 * USAGE:
 *   # Dry run (default — NO changes saved):
 *   cd backend && npx -y tsx src/scripts/category_changer.ts
 *
 *   # Apply changes:
 *   cd backend && npx -y tsx src/scripts/category_changer.ts --apply
 */

import { Client } from 'pg'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const DRY_RUN = !process.argv.includes('--apply')

// Update this label when adding new categories to the script
const SCRIPT_TARGET = 'CONSTANT VOLTAGE'

// ── Suffix rules ──────────────────────────────────────────────────────────────
// Order matters: longer/more-specific suffixes must come BEFORE shorter ones
// to avoid false matches (e.g. RGBW must be checked before RG).

interface SuffixRule {
    suffixes: string[]
    categoryName: string
}

interface PrefixRule {
    prefix: string
    categoryName: string
}

// Prefix rules — checked FIRST (these win over suffix rules)
const LED_STRIP_PREFIX_RULES: PrefixRule[] = [
    {
        // 120V Outdoor AC LED Strip accessories/products
        prefix: 'ESPA',
        categoryName: '120V OUTDOOR',
    },
    {
        prefix: 'EPS-JNA',
        categoryName: 'CONSTANT VOLTAGE',
    },
    {
        prefix: 'EPS-SW',
        categoryName: 'CONSTANT VOLTAGE',
    },
]

const LED_STRIP_RULES: SuffixRule[] = [
    {
        // RGBW checked before RG to prevent false match
        suffixes: ['RGBW', 'RW'],
        categoryName: 'RGBW LED STRIP',
    },
    {
        // RGB and RG (RG is an alias for RGB in this product line)
        suffixes: ['RGB', 'RG'],
        categoryName: 'RGB LED STRIPS',
    },
    {
        // Adjustable CCT must be checked before simple CT
        suffixes: ['CCT', 'CT'],
        categoryName: 'ADJUSTABLE COLOR TEMPERATURE LED STRIP',
    },
    {
        // White LED Strips — K variants before bare numbers to avoid 60K matching as 60
        suffixes: ['27K', '30K', '35K', '40K', '50K', '60K', '70K', '27', '30', '35', '40', '50', '60', '70'],
        categoryName: 'WHITE LED STRIPS',
    },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchCategory(sku: string): SuffixRule | PrefixRule | null {
    const upper = sku.toUpperCase()
    // Check prefix rules first
    for (const rule of LED_STRIP_PREFIX_RULES) {
        if (upper.startsWith(rule.prefix.toUpperCase())) return rule
    }
    // Then suffix rules
    for (const rule of LED_STRIP_RULES) {
        for (const suffix of rule.suffixes) {
            if (upper.endsWith(suffix.toUpperCase())) return rule
        }
    }
    return null
}

function isLedStrip(skus: string[]): boolean {
    return skus.some(sku => {
        const upper = sku.toUpperCase()
        // Standard ESP LED strip prefix
        if (upper.startsWith('ESP')) return true
        // Any SKU matching a prefix rule also qualifies
        return LED_STRIP_PREFIX_RULES.some(r => upper.startsWith(r.prefix.toUpperCase()))
    })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log(`✅ Connected to database\n`)
    console.log(DRY_RUN ? '🔍 DRY RUN — no changes will be saved\n' : '⚡ APPLY MODE — changes will be saved\n')

    // 1. Find all products with NO category assigned
    const uncategorisedRes = await client.query<{ id: string; title: string }>(`
        SELECT p.id, p.title
        FROM product p
        WHERE p.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM product_category_product pcp WHERE pcp.product_id = p.id
          )
        ORDER BY p.title
    `)

    const products = uncategorisedRes.rows

    // ── Diagnostic: show ESP product stats ───────────────────────────────────
    const diagRes = await client.query<{ status: string; count: string }>(`
        SELECT
            CASE WHEN pcp.product_id IS NOT NULL THEN 'already_categorized' ELSE 'uncategorized' END AS status,
            COUNT(DISTINCT p.id)::text AS count
        FROM product p
        JOIN product_variant pv ON pv.product_id = p.id
            AND pv.deleted_at IS NULL
            AND pv.sku ILIKE 'ESP%'
        LEFT JOIN product_category_product pcp ON pcp.product_id = p.id
        WHERE p.deleted_at IS NULL
        GROUP BY 1
    `)
    const diagMap = Object.fromEntries(diagRes.rows.map(r => [r.status, parseInt(r.count)]))
    console.log('📊 ESP variant products (all):')
    console.log(`   ✅ Already categorized : ${diagMap['already_categorized'] ?? 0}`)
    console.log(`   ⏳ Uncategorized        : ${diagMap['uncategorized'] ?? 0}`)
    console.log()
    console.log(`📦 Uncategorised products found: ${products.length}\n`)

    if (products.length === 0) {
        console.log('✅ No uncategorised products — nothing to do.')
        await client.end()
        return
    }

    // 2. Fetch all variant SKUs for these products in one query
    const productIds = products.map(p => p.id)
    const variantsRes = await client.query<{ product_id: string; sku: string }>(`
        SELECT pv.product_id, pv.sku
        FROM product_variant pv
        WHERE pv.product_id = ANY($1::text[])
          AND pv.deleted_at IS NULL
          AND pv.sku IS NOT NULL
          AND pv.sku != ''
    `, [productIds])

    // Build a map: product_id → [skus]
    const skuMap = new Map<string, string[]>()
    for (const row of variantsRes.rows) {
        if (!skuMap.has(row.product_id)) skuMap.set(row.product_id, [])
        skuMap.get(row.product_id)!.push(row.sku)
    }

    // 3. Fetch all existing categories (name → id) for lookup
    const catRes = await client.query<{ id: string; name: string }>(`
        SELECT id, name FROM product_category WHERE deleted_at IS NULL
    `)
    const categoryMap = new Map<string, string>()
    for (const row of catRes.rows) {
        categoryMap.set(row.name.toLowerCase().trim(), row.id)
    }

    // 4. Process each product
    const results: { product: string; skus: string[]; matchedSku: string; category: string; status: string }[] = []
    const skipped: { product: string; reason: string }[] = []

    for (const product of products) {
        const skus = skuMap.get(product.id) ?? []

        if (skus.length === 0) {
            skipped.push({ product: product.title, reason: 'no variants / no SKUs' })
            continue
        }

        // Only process if it's a LED Strip (has at least one ESP variant)
        if (!isLedStrip(skus)) {
            skipped.push({ product: product.title, reason: `no matching prefix — not a ${SCRIPT_TARGET} product` })
            continue
        }

        // Collect all SKUs that are LED Strip candidates (ESP prefix OR any prefix rule)
        const espSkus = skus.filter(s => {
            const upper = s.toUpperCase()
            if (upper.startsWith('ESP')) return true
            return LED_STRIP_PREFIX_RULES.some(r => upper.startsWith(r.prefix.toUpperCase()))
        })
        let matchedRule: SuffixRule | PrefixRule | null = null
        let matchedSku = ''

        for (const sku of espSkus) {
            const rule = matchCategory(sku)
            if (rule) {
                matchedRule = rule
                matchedSku = sku
                break
            }
        }

        if (!matchedRule) {
            skipped.push({ product: product.title, reason: `ESP SKUs [${espSkus.join(', ')}] — no suffix match` })
            continue
        }

        // Look up category ID
        const categoryId = categoryMap.get(matchedRule.categoryName.toLowerCase().trim())
        if (!categoryId) {
            skipped.push({ product: product.title, reason: `Category "${matchedRule.categoryName}" NOT FOUND in Medusa` })
            continue
        }

        // Apply or dry-run
        if (!DRY_RUN) {
            await client.query(`
                INSERT INTO product_category_product (product_id, product_category_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
            `, [product.id, categoryId])
        }

        results.push({
            product: product.title,
            skus: espSkus,
            matchedSku,
            category: matchedRule.categoryName,
            status: DRY_RUN ? '→ would assign' : '✅ assigned',
        })
    }

    // 5. Print results
    console.log(`\n═══════════════════════════════════════`)
    console.log(`  MATCHES — will be assigned (${results.length})`)
    console.log(`═══════════════════════════════════════`)
    for (const r of results) {
        console.log(`  ${r.status} [${r.matchedSku}] "${r.product}"`)
        console.log(`    → ${r.category}`)
    }

    console.log(`\n═══════════════════════════════════════`)
    console.log(`  SKIPPED (${skipped.length})`)
    console.log(`═══════════════════════════════════════`)
    for (const s of skipped) {
        console.log(`  ⏭  "${s.product}" — ${s.reason}`)
    }

    console.log(`\n── Summary ────────────────────────────`)
    console.log(`  Matched:  ${results.length}`)
    console.log(`  Skipped:  ${skipped.length}`)
    console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN (pass --apply to save)' : 'APPLIED ✅'}`)
    console.log(`───────────────────────────────────────\n`)

    await client.end()
}

main().catch(err => {
    console.error('❌ Error:', err)
    process.exit(1)
})
