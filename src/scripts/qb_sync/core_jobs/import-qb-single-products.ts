#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { IProductModuleService } from "@medusajs/types"
import * as fs from "fs"

/**
 * import-qb-single-products.ts
 *
 * Phase 1: Creates the SINGLE QB inventory items as Medusa draft products.
 * Reads from /tmp/qb-migration-analysis.json (output of analyze-qb-products-migration.ts)
 *
 * Product structure:
 *   - title:       QB SKU
 *   - handle:      slugify(SKU)
 *   - status:      draft
 *   - metadata:    { sales_description, prerender: false, qb_imported: true, qb_import_date }
 *   - options:     [{ title: "Title", values: ["Default"] }]
 *   - variant:     { title: "Default", sku: QBsku, prices: [{ currency_code: "usd", amount }],
 *                    metadata: { quickbooks_list_id } }
 *
 * Safe to re-run: skips any SKU that already has a variant in Medusa.
 *
 * Usage:
 *   npx medusa exec src/scripts/migrate/import-qb-single-products.ts
 */

const ANALYSIS_FILE = "/tmp/qb-migration-analysis.json"
const RESULTS_FILE = "/tmp/qb-import-single-results.json"
const BATCH_SIZE = 30

// ── Slug helper ───────────────────────────────────────────────────────────────
function slugify(str: string): string {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumeric runs with dash
        .replace(/^-+|-+$/g, "")     // trim leading/trailing dashes
}

function priceToAmount(price: any): number {
    if (!price) return 0
    const n = typeof price === "string" ? parseFloat(price) : Number(price)
    if (isNaN(n)) return 0
    return Math.round(n * 100)  // Medusa stores in cents
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function importQbSingleProducts({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule: IProductModuleService = container.resolve(Modules.PRODUCT)

    logger.info("=".repeat(65))
    logger.info("📦 QB Single Products Import — Phase 1")
    logger.info("=".repeat(65))

    // 1. Load analysis file
    if (!fs.existsSync(ANALYSIS_FILE)) {
        logger.error(`❌ Analysis file not found: ${ANALYSIS_FILE}`)
        logger.error(`   Run first: npx medusa exec src/scripts/migrate/analyze-qb-products-migration.ts`)
        return
    }

    const analysis = JSON.parse(fs.readFileSync(ANALYSIS_FILE, "utf8"))
    const singles: { sku: string; description: string; price: any }[] = analysis.singles || []

    logger.info(`📋 Singles from analysis: ${singles.length}`)
    logger.info(`   File generated: ${analysis.generatedAt}`)

    // 2. Fetch existing variant SKUs (to skip already-imported ones)
    logger.info("\n🔍 Fetching existing Medusa variant SKUs...")
    const { data: existingVariants } = await query.graph({
        entity: "variant",
        fields: ["id", "sku"],
    })
    const existingSkus = new Set(existingVariants.filter((v: any) => v.sku).map((v: any) => v.sku.trim()))
    logger.info(`   Already in Medusa: ${existingSkus.size} variants with SKU`)

    // Filter to only truly missing items
    const toCreate = singles.filter(s => !existingSkus.has(s.sku))
    const skipped = singles.length - toCreate.length
    logger.info(`   To create: ${toCreate.length} (skipping ${skipped} already exist)`)

    if (toCreate.length === 0) {
        logger.info("\n✅ All single products already exist in Medusa. Nothing to do.")
        return
    }

    const importDate = new Date().toISOString().slice(0, 10)

    // 3. Create in batches
    logger.info(`\n✍️  Creating ${toCreate.length} products in batches of ${BATCH_SIZE}...`)
    logger.info("   (All products created as 'draft' — not visible on store)")

    let created = 0
    let failed = 0
    const errors: { sku: string; error: string }[] = []
    const createdIds: string[] = []

    const batches = Math.ceil(toCreate.length / BATCH_SIZE)

    for (let batchIdx = 0; batchIdx < batches; batchIdx++) {
        const batch = toCreate.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE)

        const productInputs = batch.map(item => {
            const handle = slugify(item.sku)
            const amount = priceToAmount(item.price)

            return {
                title: item.sku,
                handle,
                status: "draft" as const,
                description: null,
                metadata: {
                    sales_description: item.description || null,
                    prerender: false,
                    qb_imported: true,
                    qb_import_date: importDate,
                },
                variants: [{
                    title: "Default",
                    sku: item.sku,
                    manage_inventory: true,
                    allow_backorder: false,
                    prices: amount > 0 ? [{ currency_code: "usd", amount }] : [],
                    metadata: {
                        // quickbooks_list_id will be added in a follow-up sync once we have the full listId map
                        qb_sku: item.sku,
                    },
                }],
            }
        })

        try {
            const results = await productModule.createProducts(productInputs as any)
            const count = Array.isArray(results) ? results.length : 1
            created += count
            if (Array.isArray(results)) {
                results.forEach((r: any) => createdIds.push(r.id))
            }

            if ((batchIdx + 1) % 5 === 0 || batchIdx === batches - 1) {
                logger.info(`   ✅ Progress: ${created}/${toCreate.length} products created (batch ${batchIdx + 1}/${batches})`)
            }
        } catch (err: any) {
            failed += batch.length
            const skuList = batch.map(b => b.sku).join(", ").slice(0, 100)
            logger.error(`   ❌ Batch ${batchIdx + 1} failed (${batch.length} items): ${err.message}`)
            errors.push({ sku: `batch_${batchIdx + 1}: ${skuList}`, error: err.message })

            // Fallback: try one-by-one for this batch
            logger.info(`   🔄 Retrying batch ${batchIdx + 1} one-by-one...`)
            failed -= batch.length  // reset batch count, will recount below
            for (const item of batch) {
                try {
                    const handle = slugify(item.sku)
                    const amount = priceToAmount(item.price)
                    const [result] = await productModule.createProducts([{
                        title: item.sku,
                        handle,
                        status: "draft" as const,
                        metadata: {
                            sales_description: item.description || null,
                            prerender: false,
                            qb_imported: true,
                            qb_import_date: importDate,
                        },
                        variants: [{
                            title: "Default",
                            sku: item.sku,
                            manage_inventory: true,
                            allow_backorder: false,
                            prices: amount > 0 ? [{ currency_code: "usd", amount }] : [],
                            metadata: { qb_sku: item.sku },
                        }],
                    } as any])
                    created++
                    createdIds.push((result as any).id)
                } catch (singleErr: any) {
                    failed++
                    errors.push({ sku: item.sku, error: singleErr.message })
                    logger.error(`      ❌ Failed: ${item.sku} — ${singleErr.message}`)
                }
            }
        }
    }

    // 4. Summary
    logger.info("\n" + "=".repeat(65))
    logger.info("✅ IMPORT COMPLETE")
    logger.info("=".repeat(65))
    logger.info(`   Created:  ${created}`)
    logger.info(`   Failed:   ${failed}`)
    logger.info(`   Skipped:  ${skipped} (already existed)`)
    logger.info(`   Total:    ${created + failed + skipped} / ${singles.length}`)
    logger.info("")
    logger.info("⚠️  MeiliSearch is NOT updated automatically for bulk scripts.")
    logger.info("   → Go to /app/products-advanced → click 'Check Product Sync'")
    logger.info("=".repeat(65))

    // 5. Save results JSON
    const results = {
        completedAt: new Date().toISOString(),
        summary: { created, failed, skipped, total: singles.length },
        errors,
        createdIds,
    }
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf8")
    logger.info(`\n📄 Results saved to: ${RESULTS_FILE}`)
}
