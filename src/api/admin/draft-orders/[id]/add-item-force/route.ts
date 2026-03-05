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
    const { variant_id, quantity = 1, unit_price } = req.body as {
        variant_id: string
        quantity?: number
        unit_price?: number  // in DOLLARS (e.g. 29.99)
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
        let resolvedPrice = 0  // in DOLLARS (orderModule convention)

        // ── Attempt 1: resolve via Product Module (fastest path) ──────────────
        try {
            const [variant] = await productModule.listProductVariants(
                { id: [variant_id] },
                { relations: ["prices", "product"] }
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
                    `${base}/admin/products?variants[id][]=${variant_id}&fields=title,thumbnail,variants.title,variants.id,variants.prices`,
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
                        console.log(`[add-item-force] Fallback API resolved title="${title}" sku="${variantSku}" for ${variant_id}`)
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

        // createOrderLineItems is the correct module-level API (no workflow, no inventory check)
        // IMPORTANT: Accepts unit_price in DOLLARS (same as Medusa REST API)
        await orderModule.createOrderLineItems(id, [{
            variant_id,
            product_id: productId,      // CRITICAL: without this, Medusa Admin skips SKU rendering
            quantity,
            unit_price: resolvedPrice,
            title,
            subtitle: variantTitle,     // variant title shown under product name (e.g. "6000K")
            variant_title: variantTitle,
            variant_sku: variantSku,    // SKU shown as first gray line in Medusa Admin order detail
            product_title: productTitle ?? title,  // denormalized for order history
            product_handle: productHandle,          // denormalized for order history
            thumbnail,
            is_discountable: true,
            requires_shipping: true,
        }])

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[add-item-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add item" })
    }
}

