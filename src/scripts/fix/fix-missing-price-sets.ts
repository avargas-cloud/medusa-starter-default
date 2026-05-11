/**
 * fix-missing-price-sets.ts
 *
 * Creates missing price_set records and links them to variants that were
 * created without one. Without a price_set, the admin UI throws
 * "No price set linked to this variant" and prices cannot be set.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/fix-missing-price-sets.ts
 */

import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

const TARGET_SKUS = ["SUP-FC2R4N70W0840", "SUP-FC2R4N70W0860"]

export default async function fixMissingPriceSets({
  container,
}: {
  container: MedusaContainer
}) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingModule = container.resolve(Modules.PRICING) as any
  const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK)

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku: TARGET_SKUS },
  })

  console.log(`Found ${variants.length} variant(s) to process:`)

  for (const variant of variants) {
    console.log(`\nProcessing ${variant.sku} (${variant.id})`)

    // Check if already has a price set
    const { data: existing } = await query.graph({
      entity: "product_variant",
      fields: ["id", "price_set.*"],
      filters: { id: variant.id },
    })

    const hasPriceSet =
      existing?.[0]?.price_set && existing[0].price_set.length > 0
    if (hasPriceSet) {
      console.log(`  ✓ Already has price set, skipping`)
      continue
    }

    // Create a new price_set (empty, no prices yet)
    const [priceSet] = await pricingModule.createPriceSets([{}])
    console.log(`  ✓ Created price_set: ${priceSet.id}`)

    // Link variant → price_set
    await remoteLink.create({
      [Modules.PRODUCT]: { product_variant_id: variant.id },
      [Modules.PRICING]: { price_set_id: priceSet.id },
    })
    console.log(`  ✓ Linked variant → price_set`)
  }

  console.log("\nDone. You can now set prices from the admin UI.")
}
