import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function checkCategories({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    // Get sample products with categories
    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "categories.name",
            "categories.handle",
        ],
    })

    logger.info(`Total products: ${products.length}`)

    // Show first 5 with categories
    const withCategories = products.filter((p: any) => p.categories?.length > 0).slice(0, 5)

    logger.info("\nSample products with categories:")
    withCategories.forEach((p: any) => {
        logger.info(`- ${p.title}`)
        p.categories.forEach((c: any) => {
            logger.info(`  → ${c.name} (${c.handle})`)
        })
    })

    // Get all unique categories
    const allCategories = new Set()
    products.forEach((p: any) => {
        p.categories?.forEach((c: any) => {
            allCategories.add(c.handle)
        })
    })

    logger.info(`\nTotal unique category handles: ${allCategories.size}`)
    logger.info(Array.from(allCategories).sort().join(", "))
}
