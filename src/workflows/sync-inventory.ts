import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/utils"

export const syncInventoryToMeiliStep = createStep(
    "sync-to-meili-step",
    async (_, { container }) => {
        const { MeiliSearch } = await import("meilisearch")
        const query = container.resolve("query") as any
        const pricingService: any = container.resolve(Modules.PRICING)

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // ─── BULK: Load all price list prices once ──────────────────────────────
        // Result: Map<price_set_id, Record<price_list_id, amount>>
        // Used for O(1) lookup per variant — no per-variant queries.
        const pricesByPriceSet = new Map<string, Record<string, number>>()
        try {
            const allPriceLists = await pricingService.listPriceLists()
            const priceListIds = allPriceLists.map((pl: any) => pl.id)

            if (priceListIds.length > 0) {
                const priceListPrices = await pricingService.listPrices({
                    price_list_id: priceListIds,
                })
                for (const p of priceListPrices) {
                    if (!p.price_set_id || !p.price_list_id || p.currency_code !== "usd") continue
                    if (!pricesByPriceSet.has(p.price_set_id)) {
                        pricesByPriceSet.set(p.price_set_id, {})
                    }
                    pricesByPriceSet.get(p.price_set_id)![p.price_list_id] = p.amount
                }
            }
        } catch (e: any) {
            // Non-blocking: if price list fetch fails, pricesByList will be empty
            console.warn("[sync-inventory] Could not load price list prices:", e.message)
        }

        // Fetch all variants with their inventory items, prices, and product info in batches
        let allVariants: any[] = []
        let skip = 0
        const take = 500
        let hasMore = true

        while (hasMore) {
            const { data: batch } = await query.graph({
                entity: "product_variant",
                fields: [
                    "id",
                    "sku",
                    "metadata",
                    "created_at",
                    "updated_at",
                    "price_set.id",
                    "product.id",
                    "product.title",
                    "product.handle",
                    "product.thumbnail",
                    "product.status",
                    "product.metadata",
                    "product.categories.id",
                    "product.categories.handle",
                    "product.categories.parent_category.handle",
                    "product.categories.parent_category.parent_category.handle",
                    "prices.amount",
                    "prices.currency_code",
                    "prices.price_list_id",
                    "inventory_items.inventory.id",
                    "inventory_items.inventory.sku",
                    "inventory_items.inventory.title",
                    "inventory_items.inventory.created_at",
                    "inventory_items.inventory.updated_at",
                    "inventory_items.inventory.stocked_quantity",
                    "inventory_items.inventory.reserved_quantity",
                    "options.value",
                    "options.option.title",
                ],
                pagination: { skip, take }
            })

            if (batch.length === 0) {
                hasMore = false
                break
            }

            allVariants = allVariants.concat(batch)
            skip += take
        }

        console.log(`🔍 [DEBUG] Fetched ${allVariants.length} variants for MeiliSearch inventory sync`)

        // Transform variants → inventory items for MeiliSearch
        const meiliInventoryItems = allVariants.flatMap((variant: any) => {
            const product = variant.product

            // RETAIL = highest USD price (query graph returns price_list_id as null always,
            // so max amount = retail since wholesale is always 10% less)
            const usdPrices = (variant.prices || []).filter((p: any) => p.currency_code === "usd")
            const retailPrice = usdPrices.length > 0
                ? usdPrices.reduce((max: any, p: any) => p.amount > max.amount ? p : max)
                : null

            // Prices by price list for dynamic columns
            // Empty object if no price list prices found — frontend uses retail as fallback
            const priceSetId = variant.price_set?.id
            const pricesByList = priceSetId
                ? pricesByPriceSet.get(priceSetId) ?? {}
                : {}

            // Flatten all category handles (including parents)
            const allCategoryHandles = new Set<string>()
            product?.categories?.forEach((c: any) => {
                if (c.handle) allCategoryHandles.add(c.handle)
                if (c.parent_category?.handle) allCategoryHandles.add(c.parent_category.handle)
                if (c.parent_category?.parent_category?.handle) allCategoryHandles.add(c.parent_category.parent_category.handle)
            })

            // Map variant options (Color Temperature = 3000K)
            const mappedOptions = (variant.options || []).map((opt: any) => ({
                title: opt.option?.title || "Option",
                value: opt.value || "",
            }))

            // Map each inventory item linked to this variant.
            // If no inventory items exist (manage_inventory:false — services), emit a
            // synthetic document so the variant still appears in the POS product browser.
            if (!variant.inventory_items || variant.inventory_items.length === 0) {
                // Only include if the variant has a SKU (services always do)
                if (!variant.sku) return []
                return [{
                    id: variant.id,                          // variant.id as primary key (no inv item)
                    sku: variant.sku,
                    title: product?.title || 'Untitled',
                    thumbnail: product?.thumbnail || null,
                    totalStock: null,                        // null = unmanaged / unlimited
                    totalReserved: 0,
                    price: retailPrice?.amount || 0,
                    currencyCode: retailPrice?.currency_code?.toUpperCase() || 'USD',
                    pricesByList,
                    variantId: variant.id,
                    productId: product?.id || null,
                    handle: product?.handle || null,
                    salesDescription: (variant?.metadata as any)?.sales_description
                        || (product?.metadata as any)?.sales_description
                        || null,
                    options: mappedOptions,
                    category_handles: Array.from(allCategoryHandles),
                    status: product?.status || 'draft',
                    created_at: new Date(variant.created_at).getTime(),
                    updated_at: new Date(variant.updated_at).getTime(),
                }]
            }

            return (variant.inventory_items || []).map((invItem: any) => {
                const inventory = invItem.inventory
                return {
                    id: inventory.id,
                    sku: inventory.sku || variant.sku || "",
                    title: inventory.title || product?.title || "Untitled",
                    thumbnail: product?.thumbnail || null,
                    totalStock: inventory.stocked_quantity || 0,
                    totalReserved: inventory.reserved_quantity || 0,
                    price: retailPrice?.amount || 0,       // RETAIL (base, max USD)
                    currencyCode: retailPrice?.currency_code?.toUpperCase() || "USD",
                    pricesByList,                           // { [price_list_id]: amount }
                    variantId: variant.id,
                    productId: product?.id || null,
                    handle: product?.handle || null,
                    // Prefer variant-level description (correct per-SKU from QB).
                    // Fall back to product-level for variants not yet migrated.
                    salesDescription: (variant?.metadata as any)?.sales_description
                        || (product?.metadata as any)?.sales_description
                        || null,
                    options: mappedOptions,
                    category_handles: Array.from(allCategoryHandles),
                    status: product?.status || "draft",
                    created_at: new Date(inventory.created_at || variant.created_at).getTime(),
                    updated_at: new Date(inventory.updated_at || variant.updated_at).getTime(),
                }
            })

        })

        // Filter out orphaned items
        const validItems = meiliInventoryItems.filter((item: any) => item.variantId && item.productId)

        // Sync to MeiliSearch
        const index = client.index("inventory")

        // Update settings (idempotent, fast)
        await index.updateSettings({
            filterableAttributes: [
                "category_handles",
                "status",
                "id",
                "sku"
            ],
            sortableAttributes: [
                "title",
                "sku",
                "totalStock",
                "price",
                "totalReserved",
                "updated_at",
                "created_at"
            ],
            searchableAttributes: [
                "title",
                "sku"
            ]
        })

        // Atomic replacement
        await index.deleteAllDocuments()
        const result = await index.addDocuments(validItems, { primaryKey: "id" })

        // BLOCKING: Wait for MeiliSearch to finish indexing before returning
        await (client as any).tasks.waitForTask(result.taskUid)

        const withCategory = validItems.filter((i: any) => i.category_handles.length > 0)

        return new StepResponse({
            success: true,
            synced: validItems.length,
            itemsWithCategory: withCategory.length,
            taskUid: result.taskUid
        })
    }
)

export const syncInventoryWorkflow = createWorkflow(
    "sync-inventory-workflow",
    () => {
        const result = syncInventoryToMeiliStep()
        return new WorkflowResponse(result)
    }
)
