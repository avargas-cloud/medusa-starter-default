import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export default async function healAllVariants({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK)
    const productService = container.resolve(Modules.PRODUCT)

    const attributeModule = container.resolve("product-attributes")

    logger.info("🏥 Initiating Global Variant Healing Protocol...")

    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "metadata",
            "options.*",
            "variants.*",
            "variants.options.*"
        ],
    })

    const { data: allAttributeKeys } = await query.graph({
        entity: "attribute_key",
        fields: ["id", "handle", "label", "options"]
    })

    let healedCount = 0

    for (const product of products) {
        const productVariantAttributes = new Set(product.metadata?.variant_attributes as string[] || [])
        let productUpdated = false

        // Identify attributes that should trigger variant creation
        for (const option of product.options) {
            // Logic: Match Product Option Title to Attribute Key Label or Handle (Case-insensitive)
            const matchingKey = allAttributeKeys.find(
                k => k.label.toLowerCase() === option.title.toLowerCase() ||
                    k.handle.toLowerCase() === option.title.toLowerCase()
            )

            if (matchingKey) {
                logger.info(`🔗 Match found: Option '${option.title}' -> Attribute '${matchingKey.label}' in Product ${product.id}`)

                // Add to metadata if not present
                if (!productVariantAttributes.has(matchingKey.handle)) {
                    productVariantAttributes.add(matchingKey.handle)
                    productUpdated = true
                }

                // Get unique values used by variants for this option
                const uniqueValues = new Set(
                    product.variants.flatMap(v =>
                        v.options.filter(o => o.option_id === option.id).map(o => o.value)
                    )
                )

                for (const value of uniqueValues) {
                    // Retrieve or Create Logic implemented manually since it's not on the service
                    // @ts-ignore - dynamic service method access
                    let [attributeValue] = await attributeModule.listAttributeValues({
                        attribute_key_id: matchingKey.id,
                        value: value
                    })

                    if (!attributeValue) {
                        // @ts-ignore - dynamic service method access
                        attributeValue = await attributeModule.createAttributeValues({
                            attribute_key_id: matchingKey.id,
                            value: value,
                            metadata: { created_by: "heal-script" }
                        })
                        logger.info(`   ➕ Created new Attribute Value: '${value}' for Key '${matchingKey.handle}'`)
                    }

                    try {
                        await remoteLink.create({
                            [Modules.PRODUCT]: {
                                product_id: product.id,
                            },
                            "product-attributes": {
                                attribute_value_id: attributeValue.id,
                            },
                        })
                    } catch (e) {
                        // Ignore if link already exists (idempotency)
                    }
                }
            }
        }

        if (productUpdated) {
            await productService.updateProducts(product.id, {
                metadata: {
                    ...product.metadata,
                    variant_attributes: Array.from(productVariantAttributes)
                }
            })
            healedCount++
        }
    }

    logger.info(`✅ Healing Complete. Products updated: ${healedCount}`)
}
