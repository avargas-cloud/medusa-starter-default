import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

import {
  ProductShape,
  VariantImageShape,
  VariantShape,
  resolveVariantThumbnails,
} from "../lib/variant-thumbnails/resolve"

/**
 * VARIANT MEDIA → AUTO-THUMBNAIL SYNC
 *
 * When a variant's images are updated via the admin UI, sets
 * variant.thumbnail to the first image that is unique to that variant
 * within its product (not shared with sibling variants).
 *
 * Fires on product-variant.updated (emitted by updateProductVariantsWorkflow)
 * and product.updated (emitted when variants are changed as part of a product
 * update). Both events carry the changed ID(s); we fetch the full product
 * context needed for the uniqueness check.
 *
 * Loop guard: the resolver skips variants where thumbnail is already correct,
 * so the updateProductVariants call below won't re-trigger infinite cycles.
 */
export default async function syncVariantThumbnailSubscriber({
  event,
  container,
}: SubscriberArgs<{ id: string | string[] }>) {
  const logger = container.resolve("logger")
  const query = container.resolve("query")
  const productService = container.resolve(Modules.PRODUCT)

  const rawId = event.data?.id
  if (!rawId) return

  const variantIds = Array.isArray(rawId) ? rawId : [rawId]

  // Resolve parent product IDs for all affected variants
  const { data: variants } = await (query as any).graph({
    entity: "product_variant",
    fields: ["id", "product.id"],
    filters: { id: variantIds },
  })

  const productIds = [
    ...new Set(
      (variants as any[])
        .map((v) => v.product?.id)
        .filter((id): id is string => Boolean(id))
    ),
  ]

  if (productIds.length === 0) return

  // For each parent product, run the resolver and apply updates
  for (const productId of productIds) {
    let product: ProductShape

    try {
      const { data: products } = await (query as any).graph({
        entity: "product",
        fields: [
          "id",
          "thumbnail",
          "variants.id",
          "variants.thumbnail",
          "variants.images.id",
          "variants.images.url",
          "variants.images.created_at",
        ],
        filters: { id: productId },
      })

      const raw = (products as any[])[0]
      if (!raw) continue

      product = {
        id: raw.id,
        thumbnail: raw.thumbnail ?? null,
        variants: ((raw.variants as any[]) ?? []).map(
          (v): VariantShape => ({
            id: v.id,
            thumbnail: v.thumbnail ?? null,
            images: [...((v.images as any[]) ?? [])].sort(
              (a, b) =>
                new Date(a.created_at ?? 0).getTime() -
                new Date(b.created_at ?? 0).getTime()
            ) as VariantImageShape[],
          })
        ),
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        `[SyncVariantThumbnail] Failed to fetch product ${productId}: ${msg}`
      )
      continue
    }

    const updates = resolveVariantThumbnails(product)
    if (updates.length === 0) continue

    try {
      for (const u of updates) {
        await productService.updateProductVariants(u.variantId, {
          thumbnail: u.thumbnail,
        })
      }
      for (const u of updates) {
        logger.info(
          `[SyncVariantThumbnail] Set thumbnail for variant ${u.variantId}: ${u.thumbnail}`
        )
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        `[SyncVariantThumbnail] Failed to update variants for product ${productId}: ${msg}`
      )
    }
  }
}

export const config: SubscriberConfig = {
  event: ["product-variant.updated", "product.updated"],
}
