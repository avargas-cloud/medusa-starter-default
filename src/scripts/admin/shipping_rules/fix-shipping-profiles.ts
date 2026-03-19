/**
 * Script: fix-shipping-profiles
 *
 * Links every Medusa product that has no shipping profile to the default one
 * (sp_01KFH54TAP34J6ZYRE1NZWGSG2).
 *
 * In Medusa v2 the product ↔ shipping_profile relationship is a REMOTE LINK
 * between the Product module and the Fulfillment module — it is NOT a column on
 * the product table.  This script replicates the behaviour of Medusa's own
 * migration-scripts/migrate-product-shipping-profile.js.
 *
 * Run with:
 *   npx medusa exec src/scripts/fix-shipping-profiles.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import {
    ContainerRegistrationKeys,
    Modules,
} from "@medusajs/utils"

const SHIPPING_PROFILE_ID = "sp_01KFH54TAP34J6ZYRE1NZWGSG2"
const BATCH_SIZE = 100

export default async function fixShippingProfiles({ container }: ExecArgs) {
    const logger = (container as any).resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const link = container.resolve(ContainerRegistrationKeys.LINK)

    logger.info(`[fix-shipping-profiles] Starting. Profile: ${SHIPPING_PROFILE_ID}`)

    let offset = 0
    let totalFixed = 0

    while (true) {
        // Get all products (id only)
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "shipping_profile.id"],
            pagination: { skip: offset, take: BATCH_SIZE },
        })

        if (!products || products.length === 0) break

        // Products not linked to any shipping profile yet
        const unlinked = products.filter((p: any) => !p.shipping_profile?.id)

        if (unlinked.length > 0) {
            const links = unlinked.map((p: any) => ({
                [Modules.PRODUCT]: { product_id: p.id },
                [Modules.FULFILLMENT]: { shipping_profile_id: SHIPPING_PROFILE_ID },
            }))

            // createLinks is idempotent in Medusa — safe to run on already-linked products
            await link.create(links)
            totalFixed += unlinked.length
            logger.info(
                `[fix-shipping-profiles] Batch offset=${offset}: linked ${unlinked.length} / ${products.length}`
            )
        }

        offset += BATCH_SIZE
        if (products.length < BATCH_SIZE) break
    }

    logger.info(`[fix-shipping-profiles] Done — linked ${totalFixed} products`)
}
