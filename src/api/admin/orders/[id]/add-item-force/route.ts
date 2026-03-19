import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/add-item-force
 *
 * Adds a line item to a draft order WITHOUT inventory checks.
 * Calls orderModule.createOrderLineItems() directly — pure data layer,
 * bypasses all workflow validation including inventory.
 *
 * Body: { variant_id, quantity?, unit_price? }
 *
 * NOTE: unit_price should be in DOLLARS (decimal), matching Medusa API convention.
 *       orderModule.createOrderLineItems() also expects DOLLARS — do NOT multiply by 100.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }
    const { variant_id, quantity = 1, unit_price, sort_order, line_discount, original_unit_price, custom_title, custom_description } = req.body as {
        variant_id: string
        quantity?: number
        unit_price?: number            // effective (post-discount) price in DOLLARS
        sort_order?: number            // 0-indexed display position for drag-to-reorder
        line_discount?: { type: 'percent' | 'fixed'; value: number } | null  // POS discount descriptor
        original_unit_price?: number | null  // pre-discount price for POS rehydration
        custom_title?: string          // User-edited title for "Special Items"
        custom_description?: string    // User-edited description for "Special Items"
    }

    if (!variant_id) {
        res.status(400).json({ message: "variant_id is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any
        const productModule = req.scope.resolve(Modules.PRODUCT) as any

        // Resolve variant info for title and default price
        let title: string | undefined
        let variantTitle: string | undefined
        let variantSku: string | undefined  // goes into variant_sku (Medusa Admin renders this as the SKU line)
        let productId: string | undefined   // CRITICAL: Medusa Admin skips SKU rendering when product_id is null
        let productTitle: string | undefined  // denormalized for order history
        let productHandle: string | undefined  // denormalized for order history
        let thumbnail: string | undefined
        let salesDescription: string | undefined  // QB SalesDesc from product.metadata
        let resolvedPrice = 0  // in DOLLARS (orderModule convention)

        // ── Attempt 1: resolve via Product Module (fastest path) ──────────────
        try {
            const [variant] = await productModule.listProductVariants(
                { id: [variant_id] },
                { relations: ["prices", "product", "product.metadata", "metadata"] }
            ) as any[]

            if (!variant) {
                console.warn(`[add-item-force] productModule returned no variant for ${variant_id}`)
            } else {
                const vAny = variant as any
                const resolvedProductTitle: string | undefined = vAny?.product?.title
                const fallbackTitle: string | undefined = vAny?.title

                if (resolvedProductTitle) {
                    title = resolvedProductTitle
                    productTitle = resolvedProductTitle  // denormalized for order history
                    productHandle = vAny?.product?.handle ?? undefined  // denormalized for order history
                    variantTitle = vAny?.title !== resolvedProductTitle ? vAny?.title : undefined
                } else if (fallbackTitle) {
                    console.warn(`[add-item-force] product relation missing for ${variant_id}, using variant title "${fallbackTitle}"`)
                    title = fallbackTitle
                } else {
                    console.error(`[add-item-force] Both product.title and variant.title are empty for ${variant_id}`)
                }

                // Denormalized fields — all required for proper Medusa Admin display:
                // variant_sku → shows as "ESPFC4R4N50W0860" SKU line in order detail
                // subtitle    → shows as "6000K" variant title line in order detail
                variantSku = vAny?.sku ?? undefined
                productId = vAny?.product?.id ?? undefined
                thumbnail = vAny?.product?.thumbnail ?? undefined
                // Prefer variant-level description (correct per-SKU from QB).
                // Fall back to product-level for variants not yet migrated.
                salesDescription = (vAny?.metadata?.sales_description
                    || vAny?.product?.metadata?.sales_description) as string | undefined

                if (unit_price !== undefined) {
                    resolvedPrice = unit_price
                } else if ((vAny?.prices?.length ?? 0) > 0) {
                    resolvedPrice = vAny.prices[0].amount / 100
                }
            }
        } catch (e: any) {
            console.error(`[add-item-force] productModule.listProductVariants threw for ${variant_id}:`, e?.message)
        }

        // ── Attempt 2: fallback via admin REST API if title still unresolved ──
        if (!title) {
            console.warn(`[add-item-force] Falling back to admin API for variant ${variant_id}`)
            try {
                const base = `http://localhost:${process.env.PORT ?? 9000}`
                const varRes = await fetch(
                    `${base}/admin/products?variants[id][]=${variant_id}&fields=title,thumbnail,metadata,variants.title,variants.id,variants.sku,variants.prices`,
                    {
                        headers: {
                            "Cookie": String(req.headers["cookie"] ?? ""),
                            "Authorization": String(req.headers["authorization"] ?? ""),
                        }
                    }
                )
                if (varRes.ok) {
                    const { products } = await varRes.json()
                    const product = products?.[0]
                    if (product) {
                        title = product.title
                        productTitle = product.title
                        productHandle = product.handle ?? undefined
                        thumbnail = product.thumbnail ?? undefined
                        const v = product.variants?.find((v: any) => v.id === variant_id)
                        if (v) {
                            variantTitle = v.title !== product.title ? v.title : undefined
                            variantSku = v.sku ?? undefined
                            productId = product.id ?? undefined
                            if (unit_price === undefined && v.prices?.length > 0) {
                                resolvedPrice = v.prices[0].amount / 100
                            }
                        }
                        salesDescription = product.metadata?.sales_description as string | undefined
                        console.log(`[add-item-force] Fallback API resolved title="${title}" sku="${variantSku}" sdesc="${salesDescription ?? 'none'}" for ${variant_id}`)
                    }
                }
            } catch (e2: any) {
                console.error(`[add-item-force] Admin API fallback also failed for ${variant_id}:`, e2?.message)
            }
        }

        // ── Final check: refuse to create a line item with variant_id as title ─
        if (!title) {
            console.error(`[add-item-force] Could not resolve product title for ${variant_id}. Aborting to prevent corrupted line item.`)
            res.status(422).json({
                message: `Could not resolve product title for variant ${variant_id}. The item was NOT added. Please try again.`
            })
            return
        }

        if (unit_price !== undefined) {
            resolvedPrice = unit_price
        }

        if (custom_title) {
            title = custom_title
            productTitle = custom_title // Keep denormalized field in sync for Medusa Native Admin
        }

        if (custom_description !== undefined) {
            salesDescription = custom_description || undefined
        }

        // createOrderLineItems is the correct module-level API (no workflow, no inventory check)
        // IMPORTANT: Accepts unit_price in DOLLARS (same as Medusa REST API)
        console.log(`[orders/add-item-force] title="${title}" sdesc="${salesDescription ?? 'none'}" sku="${variantSku}"`)

        const [createdItem] = await orderModule.createOrderLineItems(id, [{
            variant_id,
            product_id: productId,
            quantity,
            unit_price: resolvedPrice,
            title,
            subtitle: variantTitle,
            variant_title: variantTitle,
            variant_sku: variantSku,
            product_title: productTitle ?? title,
            product_handle: productHandle,
            thumbnail,
            is_discountable: true,
            requires_shipping: true,
            metadata: {
                product_title: productTitle ?? title,
                ...(salesDescription ? { sales_description: salesDescription } : {}),
                ...(sort_order !== undefined ? { sort_order } : {}),
                ...(line_discount ? { line_discount } : {}),
                ...(original_unit_price != null ? { original_unit_price } : {}),
            },
        }]) as any[]

        // ── Auto-create reservation so item shows "Allocated" in Medusa Admin ─
        // Items added directly via orderModule skip the normal fulfillment flow
        // which would normally create reservations. We do it manually here.
        try {
            const base = `http://localhost:${process.env.PORT ?? 9000}`
            const authHeaders: Record<string, string> = {
                "Cookie": String(req.headers["cookie"] ?? ""),
                "Authorization": String(req.headers["authorization"] ?? ""),
                "Content-Type": "application/json",
            }

            const stockLocationModule = req.scope.resolve(Modules.STOCK_LOCATION) as any
            const remoteQuery = req.scope.resolve("remoteQuery") as any

            const locs = await stockLocationModule.listStockLocations({}, { take: 1, select: ["id"] })
            const primaryLocationId = locs?.[0]?.id

            let inventoryItemId: string | null = null
            try {
                const variantData = await remoteQuery({
                    variant: {
                        fields: ["id"],
                        __args: { filters: { id: variant_id } },
                        inventory_items: { fields: ["inventory_item_id"] }
                    }
                })
                inventoryItemId = variantData?.[0]?.inventory_items?.[0]?.inventory_item_id ?? null
            } catch (e: any) {
                console.warn(`[orders/add-item-force] remoteQuery failed:`, e?.message)
            }

            if (primaryLocationId && inventoryItemId && createdItem?.id) {
                await fetch(`${base}/admin/reservations`, {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                        line_item_id: createdItem.id,
                        inventory_item_id: inventoryItemId,
                        location_id: primaryLocationId,
                        quantity,
                        allow_backorder: true,  // ← bypasses stock check; does NOT change stock qty
                    }),
                })
                console.log(`[orders/add-item-force] ✅ Reservation created for lineItem ${createdItem.id}`)
            }
        } catch (resErr: any) {
            console.warn(`[orders/add-item-force] Reservation creation failed (non-fatal):`, resErr?.message)
        }

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[orders/add-item-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add item" })
    }
}


