#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/types"
import * as fs from "fs"

/**
 * import-qb-variant-products.ts
 *
 * Phase 2: Creates the VARIANT groups as Medusa draft products with options and variants.
 * Reads from /tmp/qb-migration-analysis.json (output of analyze-qb-products-migration.ts)
 */

const ANALYSIS_FILE = "/tmp/qb-migration-analysis.json"
const RESULTS_FILE = "/tmp/qb-import-variants-results.json"
const BATCH_SIZE = 10

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

function determineOptionTitle(variants: any[], baseSku: string): string {
    if (variants.length === 0) return "Options"
    const firstSuffix = variants[0].sku.replace(baseSku, "")
    if (/^\d/.test(firstSuffix)) return "Color Options"
    return "Finish"
}

function formatValue(suffix: string, title: string): string {
    if (title === "Color Options") {
        if (/^\d{2}$/.test(suffix)) return suffix + "00K"
        if (/^\d{2}K$/i.test(suffix)) return suffix.toUpperCase().replace("K", "00K")
        if (/^\d{4}K$/i.test(suffix)) return suffix.toUpperCase()
    }
    return suffix.toUpperCase()
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function importQbVariantProducts({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule: IProductModuleService = container.resolve(Modules.PRODUCT)

    logger.info("=".repeat(65))
    logger.info("📦 QB Variant Products Import — Phase 2")
    logger.info("=".repeat(65))

    if (!fs.existsSync(ANALYSIS_FILE)) {
        logger.error(`❌ Analysis file not found: ${ANALYSIS_FILE}`)
        return
    }

    const analysis = JSON.parse(fs.readFileSync(ANALYSIS_FILE, "utf8"))
    const groups: { baseSku: string; suffixLen: number; variants: any[] }[] = analysis.groups || []

    logger.info(`📋 Variant Groups from analysis: ${groups.length}`)

    // We can confidently try to import them all, but let's check existing SKUs just in case
    logger.info("\n🔍 Fetching existing Medusa parent handles...")
    const { data: existingProducts } = await query.graph({
        entity: "product",
        fields: ["id", "handle"],
    })
    const existingHandles = new Set(existingProducts.filter((p: any) => p.handle).map((p: any) => p.handle))

    // Filter out groups where the parent product already exists
    const toCreate = groups.filter(g => !existingHandles.has(slugify(g.baseSku)))
    const skipped = groups.length - toCreate.length

    logger.info(`   Already in Medusa: ${existingProducts.length} products`)
    logger.info(`   To create via Groups: ${toCreate.length} (skipping ${skipped} parent handles already exist)`)

    if (toCreate.length === 0) {
        logger.info("\n✅ All Variant groups already exist in Medusa. Nothing to do.")
        return
    }

    const importDate = new Date().toISOString().slice(0, 10)

    logger.info(`\n✍️  Creating ${toCreate.length} products in batches of ${BATCH_SIZE}...`)
    logger.info("   (All products created as 'draft' — not visible on store)")

    let created = 0
    let failed = 0
    const errors: { baseSku: string; error: string }[] = []
    const createdIds: string[] = []

    const batches = Math.ceil(toCreate.length / BATCH_SIZE)

    for (let batchIdx = 0; batchIdx < batches; batchIdx++) {
        const batch = toCreate.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE)

        const productInputs = batch.map(group => {
            const handle = slugify(group.baseSku)
            const optionTitle = determineOptionTitle(group.variants, group.baseSku)

            // Build unique option values for this group
            const optionValues = Array.from(new Set(group.variants.map(v => {
                const suffix = v.sku.replace(group.baseSku, "")
                return formatValue(suffix, optionTitle)
            })))

            return {
                title: group.baseSku,
                handle,
                status: "draft" as const,
                description: null,
                metadata: {
                    prerender: false,
                    qb_imported: true,
                    qb_import_date: importDate,
                    qb_is_variant_parent: true,
                },
                options: [
                    {
                        title: optionTitle,
                        values: optionValues,
                    }
                ],
                variants: group.variants.map(v => {
                    const amount = priceToAmount(v.price)
                    const suffix = v.sku.replace(group.baseSku, "")
                    const displayValue = formatValue(suffix, optionTitle)

                    return {
                        title: displayValue,
                        sku: v.sku,
                        manage_inventory: true,
                        allow_backorder: false,
                        options: {
                            [optionTitle]: displayValue
                        },
                        prices: amount > 0 ? [{ currency_code: "usd", amount }] : [],
                        metadata: { qb_sku: v.sku },
                    }
                }),
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
            const skuList = batch.map(b => b.baseSku).join(", ")
            logger.error(`   ❌ Batch ${batchIdx + 1} failed: ${err.message}`)
            errors.push({ baseSku: `batch_${batchIdx + 1}: ${skuList}`, error: err.message })

            // Try one by one
            logger.info(`   🔄 Retrying batch ${batchIdx + 1} one-by-one...`)
            failed -= batch.length

            for (const input of productInputs) {
                try {
                    const [result] = await productModule.createProducts([input as any])
                    created++
                    createdIds.push((result as any).id)
                } catch (singleErr: any) {
                    failed++
                    errors.push({ baseSku: input.title, error: singleErr.message })
                    logger.error(`      ❌ Failed: ${input.title} — ${singleErr.message}`)
                }
            }
        }
    }

    logger.info("\n" + "=".repeat(65))
    logger.info("✅ VARIANT IMPORT COMPLETE")
    logger.info("=".repeat(65))
    logger.info(`   Parent Products Created:  ${created}`)
    logger.info(`   Failed:   ${failed}`)
    logger.info(`   Skipped:  ${skipped}`)
    logger.info(`   Total:    ${created + failed + skipped} / ${groups.length}`)
    logger.info("")
    logger.info("⚠️  MeiliSearch is NOT updated automatically for bulk scripts.")
    logger.info("=".repeat(65))

    const results = {
        completedAt: new Date().toISOString(),
        summary: { created, failed, skipped, total: groups.length },
        errors,
        createdIds,
    }
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf8")
    logger.info(`\n📄 Results saved to: ${RESULTS_FILE}`)
}
