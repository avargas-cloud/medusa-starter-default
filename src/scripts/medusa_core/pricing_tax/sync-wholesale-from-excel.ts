import * as path from "path"
import * as XLSX from "xlsx"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { IPricingModuleService } from "@medusajs/types"
import { syncInventoryWorkflow } from "../../../workflows/sync-inventory"

/**
 * Wholesale price sync from wholesale.xlsx (workspace root).
 *
 * Excel format:
 *   Column A — SKU
 *   Column B — Wholesale price (USD)
 *
 * Rules:
 *   price > $0 → upsert wholesale price for that variant
 *   price = $0 → delete wholesale price (Medusa v2 falls back to retail automatically)
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/medusa_core/pricing_tax/sync-wholesale-from-excel.ts
 *   WHOLESALE_DRY_RUN=true yarn medusa exec ./src/scripts/medusa_core/pricing_tax/sync-wholesale-from-excel.ts
 */

const BULK_SIZE = 500
// wholesale.xlsx lives in workspace root; script runs from /backend
const XLSX_PATH = path.join(process.cwd(), "..", "wholesale.xlsx")

export interface WholesaleExcelSyncResult {
    success: boolean
    dryRun: boolean
    stats: {
        totalRows: number
        skuNotFound: number
        noPriceSet: number
        updated: number
        created: number
        deleted: number    // $0 rows: wholesale price removed → retail fallback
        unchanged: number
    }
    error?: string
}

export default async function syncWholesaleFromExcel({
    container,
}: {
    container: any
}): Promise<WholesaleExcelSyncResult> {
    const dryRun = process.env.WHOLESALE_DRY_RUN === "true"

    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const log = (line: string) => logger.info(line)
    const warn = (line: string) => logger.warn(line)

    const pricingModule: IPricingModuleService = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const stats: WholesaleExcelSyncResult["stats"] = {
        totalRows: 0,
        skuNotFound: 0,
        noPriceSet: 0,
        updated: 0,
        created: 0,
        deleted: 0,
        unchanged: 0,
    }

    try {
        log(`📊 Starting Wholesale Price Sync from Excel${dryRun ? " [DRY RUN — no changes will be written]" : ""}`)
        log(`📂 Reading: ${XLSX_PATH}`)

        // ── 1. Parse Excel ─────────────────────────────────────────────────────
        const workbook = XLSX.readFile(XLSX_PATH)
        // Prefer "Sheet1" if present (file also has a "QuickBooks Export Tips" tab)
        const sheetName =
            workbook.SheetNames.find((n) => n === "Sheet1") ??
            workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        log(`📑 Reading sheet: "${sheetName}"`)
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })

        // Build SKU → price map; skip header row if col A is not numeric-like
        const excelMap = new Map<string, number>()
        for (const row of rows) {
            const rawSku = (row as unknown[])[0]
            const rawPrice = (row as unknown[])[1]
            const sku = String(rawSku ?? "").trim()
            // Skip header row (col A = "sku", "item", or col B is non-numeric text)
            if (!sku || ["sku", "item"].includes(sku.toLowerCase())) continue

            const price =
                typeof rawPrice === "number"
                    ? rawPrice
                    : parseFloat(String(rawPrice ?? ""))
            if (isNaN(price)) continue
            excelMap.set(sku, price)
        }

        stats.totalRows = excelMap.size

        const toUpsert = new Map<string, number>()
        const toDelete = new Set<string>()
        for (const [sku, price] of excelMap) {
            if (price <= 0) toDelete.add(sku)
            else toUpsert.set(sku, price)
        }

        log(
            `📋 Parsed ${stats.totalRows} rows | ` +
            `${toUpsert.size} to set price | ` +
            `${toDelete.size} to delete ($0 → retail fallback)`
        )

        if (stats.totalRows === 0) {
            warn("⚠️  No rows found in Excel. Nothing to do.")
            return { success: true, dryRun, stats }
        }

        // ── 2. Fetch Wholesale Price List + Customer Group ─────────────────────
        // Mirrors the exact pattern used in sync-prices-core.ts lines 84–107
        const allPriceLists = await pricingModule.listPriceLists()
        const wPriceList = allPriceLists.find(
            (pl: any) => pl.title === "Wholesale Pricing"
        )
        const wholesalePriceListId: string | null = wPriceList?.id ?? null

        if (!wholesalePriceListId) {
            const errMsg =
                `❌ Price list "Wholesale Pricing" not found in Medusa. ` +
                `Run create-wholesale-prices.ts first.`
            logger.error(errMsg)
            return { success: false, dryRun, stats, error: errMsg }
        }
        log(`🏷️  Wholesale Price List: ${wholesalePriceListId}`)

        const customerModule = container.resolve(Modules.CUSTOMER)
        const wholesaleGroups = await customerModule.listCustomerGroups({
            name: ["Wholesale"],
        })
        const wholesaleGroupId: string | null = wholesaleGroups[0]?.id ?? null

        if (wholesaleGroupId) {
            log(`👥 Wholesale Customer Group: ${wholesaleGroupId}`)
        } else {
            warn(
                `⚠️  Wholesale customer group "Wholesale" not found — ` +
                `prices will be stored in the price list without a customer_group rule`
            )
        }

        // ── 3. Fetch all variants (only relevant SKUs) ─────────────────────────
        log("🔍 Fetching all variants from Medusa...")
        const { data: allVariants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "price_set.id"],
        })

        const skuToVariant = new Map<string, any>()
        for (const v of allVariants) {
            if (v.sku) skuToVariant.set(v.sku, v)
        }
        log(`📦 ${allVariants.length} total variants indexed by SKU`)

        // Collect price set IDs only for the SKUs we're touching
        const relevantSkus = new Set([...toUpsert.keys(), ...toDelete])
        const priceSetIds: string[] = []
        for (const sku of relevantSkus) {
            const variant = skuToVariant.get(sku)
            if (variant?.price_set?.id) priceSetIds.push(variant.price_set.id)
        }

        // ── 4. Fetch all existing prices in ONE bulk call ──────────────────────
        // Same pattern as sync-prices-core.ts lines 199–214
        log(`🔍 Fetching existing prices for ${priceSetIds.length} price sets...`)
        const allPrices =
            priceSetIds.length > 0
                ? await pricingModule.listPrices(
                      { price_set_id: priceSetIds },
                      { take: 100000 }
                  )
                : []

        // Map price_set_id → Price[]
        const pricesMap = new Map<string, any[]>()
        for (const p of allPrices) {
            const psId = p.price_set_id!
            if (!pricesMap.has(psId)) pricesMap.set(psId, [])
            pricesMap.get(psId)!.push(p)
        }

        // ── 5. Build operation queues ──────────────────────────────────────────
        // Mirrors the queue pattern in sync-prices-core.ts lines 216–319
        const wholesaleUpdates: { id: string; amount: number }[] = []
        const wholesaleCreates: {
            price_set_id: string
            price_list_id: string
            currency_code: string
            amount: number
            rules: Record<string, unknown>
        }[] = []
        const wholesaleDeletes: string[] = []

        // ── 5a. UPSERTS (price > $0) ───────────────────────────────────────────
        for (const [sku, price] of toUpsert) {
            const variant = skuToVariant.get(sku)
            if (!variant) {
                warn(`   ⚠️  SKU not found in Medusa: ${sku}`)
                stats.skuNotFound++
                continue
            }
            if (!variant.price_set?.id) {
                warn(`   ⚠️  No price set linked for SKU: ${sku}`)
                stats.noPriceSet++
                continue
            }

            const currentPrices = pricesMap.get(variant.price_set.id) ?? []
            // Identify wholesale prices by price_list_id — same filter as QB sync line 297
            const existingWholesale = currentPrices.filter(
                (p: any) => p.price_list_id === wholesalePriceListId
            )

            if (existingWholesale.length > 0) {
                const current = existingWholesale[0]

                // Skip if price is unchanged and no duplicates to clean
                if (
                    Math.abs(current.amount - price) < 0.01 &&
                    existingWholesale.length === 1
                ) {
                    stats.unchanged++
                    continue
                }

                // Update existing price — same shape as QB sync line 300–303
                wholesaleUpdates.push({ id: current.id, amount: price })

                // Clean duplicates if they exist — same as QB sync line 305–308
                if (existingWholesale.length > 1) {
                    wholesaleDeletes.push(
                        ...existingWholesale.slice(1).map((p: any) => p.id)
                    )
                }

                if (dryRun) {
                    log(
                        `   [DRY RUN] UPDATE ${sku}: ` +
                        `$${current.amount.toFixed(2)} → $${price.toFixed(2)}`
                    )
                }
                stats.updated++
            } else {
                // Create new wholesale price — same shape as QB sync line 310–316
                wholesaleCreates.push({
                    price_set_id: variant.price_set.id,
                    price_list_id: wholesalePriceListId,
                    currency_code: "usd",
                    amount: price,
                    rules: wholesaleGroupId
                        ? { customer_group_id: wholesaleGroupId }
                        : {},
                })

                if (dryRun) {
                    log(`   [DRY RUN] CREATE ${sku}: $${price.toFixed(2)}`)
                }
                stats.created++
            }
        }

        // ── 5b. DELETES (price = $0 → remove wholesale, retail becomes fallback) ─
        for (const sku of toDelete) {
            const variant = skuToVariant.get(sku)
            if (!variant) {
                stats.skuNotFound++
                continue
            }
            if (!variant.price_set?.id) {
                stats.noPriceSet++
                continue
            }

            const currentPrices = pricesMap.get(variant.price_set.id) ?? []
            const existingWholesale = currentPrices.filter(
                (p: any) => p.price_list_id === wholesalePriceListId
            )

            if (existingWholesale.length > 0) {
                wholesaleDeletes.push(...existingWholesale.map((p: any) => p.id))
                if (dryRun) {
                    const retailPrice = currentPrices.find((p: any) => !p.price_list_id)
                    log(
                        `   [DRY RUN] DELETE ${sku}: wholesale $${existingWholesale[0].amount.toFixed(2)} removed ` +
                        `(retail fallback: $${retailPrice?.amount?.toFixed(2) ?? "N/A"})`
                    )
                }
                stats.deleted++
            } else {
                // Already no wholesale price — nothing to do
                stats.unchanged++
            }
        }

        // ── 6. Apply in BULK (500-item chunks) ────────────────────────────────
        // Mirrors the bulk pattern in sync-prices-core.ts lines 322–385
        if (!dryRun) {
            log(
                `⚡ Applying: ${wholesaleUpdates.length} updates | ` +
                `${wholesaleCreates.length} creates | ` +
                `${wholesaleDeletes.length} deletes`
            )

            if (wholesaleUpdates.length > 0) {
                for (let i = 0; i < wholesaleUpdates.length; i += BULK_SIZE) {
                    const chunk = wholesaleUpdates.slice(i, i + BULK_SIZE)
                    try {
                        await (pricingModule as any).updatePrices(chunk)
                    } catch (err: unknown) {
                        logger.error(
                            `   ❌ Update chunk failed: ${err instanceof Error ? err.message : err}`
                        )
                    }
                }
                log(`   ✅ Wholesale prices updated`)
            }

            if (wholesaleCreates.length > 0) {
                for (let i = 0; i < wholesaleCreates.length; i += BULK_SIZE) {
                    const chunk = wholesaleCreates.slice(i, i + BULK_SIZE)
                    try {
                        await (pricingModule as any).createPrices(chunk)
                    } catch (err: unknown) {
                        logger.error(
                            `   ❌ Create chunk failed: ${err instanceof Error ? err.message : err}`
                        )
                    }
                }
                log(`   ✅ Wholesale prices created`)
            }

            if (wholesaleDeletes.length > 0) {
                for (let i = 0; i < wholesaleDeletes.length; i += BULK_SIZE) {
                    const chunk = wholesaleDeletes.slice(i, i + BULK_SIZE)
                    try {
                        await (pricingModule as any).deletePrices(chunk)
                    } catch (err: unknown) {
                        logger.error(
                            `   ❌ Delete chunk failed: ${err instanceof Error ? err.message : err}`
                        )
                    }
                }
                log(`   🧹 $0 wholesale prices removed (retail fallback active)`)
            }
        }

        // ── 7. Summary ────────────────────────────────────────────────────────
        log(`\n${"=".repeat(52)}`)
        log(`✅ WHOLESALE EXCEL SYNC SUMMARY${dryRun ? " [DRY RUN]" : ""}`)
        log(`${"=".repeat(52)}`)
        log(`Total Excel Rows:        ${stats.totalRows}`)
        log(`SKU Not Found:           ${stats.skuNotFound}`)
        log(`No Price Set:            ${stats.noPriceSet}`)
        log(`Updated:                 ${stats.updated}${dryRun ? " (would update)" : ""}`)
        log(`Created:                 ${stats.created}${dryRun ? " (would create)" : ""}`)
        log(`Deleted ($0 → retail):   ${stats.deleted}${dryRun ? " (would delete)" : ""}`)
        log(`Unchanged (no diff):     ${stats.unchanged}`)
        log(`${"=".repeat(52)}\n`)

        // ── 8. Re-index Meilisearch ────────────────────────────────────────────
        const hasChanges = stats.updated + stats.created + stats.deleted > 0
        if (!dryRun && hasChanges) {
            log(`🔍 Re-indexing Meilisearch inventory...`)
            try {
                const meiliResult = await syncInventoryWorkflow(container).run({
                    input: {},
                })
                log(
                    `✅ Meilisearch re-indexed ${meiliResult.result.synced} inventory items`
                )
            } catch (meiliErr: unknown) {
                warn(
                    `⚠️  Meilisearch re-index failed (non-blocking): ` +
                    `${meiliErr instanceof Error ? meiliErr.message : meiliErr}`
                )
            }
        }

        return { success: true, dryRun, stats }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.error(`❌ Wholesale Excel sync failed: ${msg}`)
        return { success: false, dryRun, stats, error: msg }
    }
}
