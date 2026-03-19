import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/utils"

/**
 * Recovery: Link Color Options to 15 Products
 * Run: yarn medusa exec ./src/scripts/recover-color-options.ts
 */
export default async function ({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const knex = container.resolve("__pg_connection__")

    logger.info('🔧 RECOVERY: Link Color Options\n')

    // 1. Get Color Options attribute key
    const colorKey = await knex('attribute_key')
        .where({ handle: 'color-options' })
        .whereNull('deleted_at')
        .first()

    if (!colorKey) {
        logger.error('❌ Color Options attribute_key not found!')
        return
    }

    logger.info(`✅ Attribute: ${colorKey.label} (${colorKey.id})`)

    // 2. Get products with Color Options option
    const result = await knex.raw(`
        SELECT p.id, p.title, po.id as option_id
        FROM product p
        INNER JOIN product_option po ON po.product_id = p.id AND po.deleted_at IS NULL
        WHERE po.title = 'Color Options' AND p.deleted_at IS NULL
            AND NOT EXISTS (
                SELECT 1 FROM product_product_productattributes_attribute_value ppa
                INNER JOIN attribute_value av ON av.id = ppa.attribute_value_id
                WHERE ppa.product_id = p.id 
                    AND av.attribute_key_id = '${colorKey.id}'
                    AND ppa.deleted_at IS NULL
            )
    `)

    logger.info(`\n📦 ${result.rows.length} products to fix\n`)

    let linked = 0

    for (const p of result.rows) {
        logger.info(`🔄 ${p.title}`)

        // Get option values
        const values = await knex('product_option_value')
            .where({ option_id: p.option_id })
            .whereNull('deleted_at')

        for (const ov of values) {
            const attrVal = await knex('attribute_value')
                .where({ attribute_key_id: colorKey.id, value: ov.value })
                .whereNull('deleted_at')
                .first()

            if (!attrVal) {
                logger.warn(`   ⚠️  "${ov.value}" not found in attribute_values`)
                continue
            }

            // Create link with generated ID
            const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

            await knex('product_product_productattributes_attribute_value').insert({
                id: linkId,
                product_id: p.id,
                attribute_value_id: attrVal.id,
                created_at: new Date(),
                updated_at: new Date()
            })

            logger.info(`   ✅ "${ov.value}"`)
            linked++
        }
    }

    logger.info(`\n✅ DONE: ${linked} links created for ${result.rows.length} products\n`)
}
