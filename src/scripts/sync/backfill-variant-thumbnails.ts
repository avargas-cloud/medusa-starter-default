/**
 * Backfill variant.thumbnail for multi-variant products.
 *
 * An image linked to exactly ONE variant within a product is treated as
 * variant-specific and becomes that variant's thumbnail. Images shared
 * across multiple variants of the same product are ignored.
 *
 * Single-variant products are skipped — their product.thumbnail already
 * serves as the fallback in the Meilisearch inventory sync.
 *
 * Dry-run by default. Set APPLY=1 to persist changes.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/sync/backfill-variant-thumbnails.ts
 *   APPLY=1 yarn medusa exec ./src/scripts/sync/backfill-variant-thumbnails.ts
 */

import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

import {
  ProductShape,
  VariantImageShape,
  VariantShape,
  resolveVariantThumbnails,
} from "../../lib/variant-thumbnails/resolve"

const IS_APPLY = process.env.APPLY === "1"
const BATCH_SIZE = 50

export default async function backfillVariantThumbnails({
  container,
}: ExecArgs) {
  const logger = (container as any).resolve("logger")
  const query = (container as any).resolve("query")
  const productService = (container as any).resolve(Modules.PRODUCT)

  logger.info(
    `[backfill-variant-thumbnails] Starting — mode=${IS_APPLY ? "APPLY" : "DRY-RUN"}`
  )

  const { data: rawProducts } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "thumbnail",
      "variants.id",
      "variants.sku",
      "variants.thumbnail",
      "variants.images.id",
      "variants.images.url",
      "variants.images.created_at",
    ],
    pagination: { skip: 0, take: 10000 },
  })

  const multiVariantProducts = (rawProducts as any[]).filter(
    (p) => Array.isArray(p.variants) && p.variants.length > 1
  )

  logger.info(
    `[backfill-variant-thumbnails] ${(rawProducts as any[]).length} products scanned, ` +
      `${multiVariantProducts.length} multi-variant`
  )

  type DiffRow = {
    handle: string
    sku: string
    currentThumb: string | null
    proposedThumb: string
  }
  const diffRows: DiffRow[] = []

  let variantsUpdated = 0
  let variantsSkippedNoUniqueImage = 0
  let variantsSkippedAlreadyCorrect = 0

  for (const rawProduct of multiVariantProducts) {
    const product: ProductShape = {
      id: rawProduct.id,
      thumbnail: rawProduct.thumbnail ?? null,
      variants: (rawProduct.variants as any[]).map(
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

    const updates = resolveVariantThumbnails(product)
    const updatedIds = new Set(updates.map((u) => u.variantId))

    for (const variant of product.variants) {
      if (updatedIds.has(variant.id)) continue
      const hasUniqueImage = variant.images.some((img) => {
        const count = product.variants.reduce(
          (acc, v) =>
            acc + (v.images.some((i) => i.id === img.id) ? 1 : 0),
          0
        )
        return count === 1
      })
      if (hasUniqueImage) {
        variantsSkippedAlreadyCorrect++
      } else {
        variantsSkippedNoUniqueImage++
      }
    }

    for (const update of updates) {
      const rawVariant = (rawProduct.variants as any[]).find(
        (v) => v.id === update.variantId
      )
      diffRows.push({
        handle: rawProduct.handle ?? rawProduct.id,
        sku: rawVariant?.sku ?? update.variantId,
        currentThumb: rawVariant?.thumbnail ?? null,
        proposedThumb: update.thumbnail,
      })
    }

    if (!IS_APPLY || updates.length === 0) continue

    for (const u of updates) {
      await productService.updateProductVariants(u.variantId, {
        thumbnail: u.thumbnail,
      })
    }
    variantsUpdated += updates.length
  }

  if (diffRows.length === 0) {
    logger.info("[backfill-variant-thumbnails] No changes needed.")
  } else {
    logger.info(`[backfill-variant-thumbnails] ${IS_APPLY ? "Applied" : "Proposed"} changes:`)
    for (const row of diffRows) {
      logger.info(
        `  ${row.handle} / ${row.sku}  |  ` +
          `${row.currentThumb ?? "(null)"}  →  ${row.proposedThumb}`
      )
    }
  }

  logger.info(
    `[backfill-variant-thumbnails] Summary — ` +
      `variantsUpdated=${variantsUpdated} ` +
      `variantsSkippedNoUniqueImage=${variantsSkippedNoUniqueImage} ` +
      `variantsSkippedAlreadyCorrect=${variantsSkippedAlreadyCorrect} ` +
      `${IS_APPLY ? "" : "(dry-run — set APPLY=1 to save)"}`
  )
}
