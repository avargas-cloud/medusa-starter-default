import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/utils"

export default async function ({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const knex = container.resolve("__pg_connection__")

    logger.info('🔍 CORRECTED: Finding products with options NOT matched to attributes\n')

    // Find products where they have a product_option 
    // but NO corresponding attribute with that option's values
    const result = await knex.raw(`
        SELECT 
            p.id,
            p.title as product_title,
            po.title as option_title,
            COUNT(DISTINCT pov.id) as option_values
        FROM product p
        INNER JOIN product_option po ON po.product_id = p.id AND po.deleted_at IS NULL
        INNER JOIN product_option_value pov ON pov.option_id = po.id AND pov.deleted_at IS NULL
        WHERE po.title NOT IN ('Title', 'Default', 'title', 'default')
            AND p.deleted_at IS NULL
            -- Check if this specific option has NO matching attribute
            AND NOT EXISTS (
                SELECT 1 
                FROM product_product_productattributes_attribute_value ppa
                INNER JOIN attribute_value av ON av.id = ppa.attribute_value_id AND av.deleted_at IS NULL
                INNER JOIN attribute_key ak ON ak.id = av.attribute_key_id AND ak.deleted_at IS NULL
                WHERE ppa.product_id = p.id
                    AND ppa.deleted_at IS NULL
                    AND (ak.label = po.title OR ak.handle = LOWER(REPLACE(po.title, ' ', '-')))
            )
        GROUP BY p.id, p.title, po.title
        ORDER BY po.title, p.title
    `)

    logger.info(`📊 Found ${result.rows.length} products with options missing corresponding attributes\n`)

    if (result.rows.length === 0) {
        logger.info('✅ All product options have matching attributes!')
    } else {
        const grouped = result.rows.reduce((acc: any, r: any) => {
            if (!acc[r.option_title]) acc[r.option_title] = []
            acc[r.option_title].push(r)
            return acc
        }, {})

        Object.keys(grouped).forEach(optionTitle => {
            logger.info(`\n📌 Option: "${optionTitle}" (${grouped[optionTitle].length} products missing)`)
            grouped[optionTitle].forEach((r: any, i: number) => {
                logger.info(`   ${i + 1}. ${r.product_title} (${r.option_values} values)`)
            })
        })
    }
}
