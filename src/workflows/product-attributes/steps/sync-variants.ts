import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

interface SyncStepInput {
    productId: string
    attributeKeyId: string
}

export const syncVariantsStep = createStep(
    "sync-variants-step",
    async ({ productId, attributeKeyId }: SyncStepInput, { container }) => {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const productModule = container.resolve(Modules.PRODUCT)
        const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

        logger.info(`[Sync Variants] Starting sync for Product: ${productId}, Key: ${attributeKeyId}`)

        // 1. Fetch Product with Variants and Options
        const { data: [product] } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "handle",
                "title",
                "options.*",
                "variants.*",
                "variants.options.*"
            ],
            filters: { id: productId }
        })

        // 2. Fetch Attribute Info (The "Source of Truth")
        // We need the Label (to name the Option) and the Values
        // We can query the pivot to get linked values, or just the AttributeKey if we trust the selection
        // Let's query the AttributeKey directly to get its label/handle, 
        // AND query the linked values for this product to be safe (or just all values of that key? 
        // The user said "Option is the Attribute", so we use the Attribute Key definitions).

        // Actually, we need the values linked to THIS product to match against.
        // Or do we match against ALL values of that key?
        // "EL OPTION ES EL ATTRIBUTO Y LOS TITLES SON LOS VALORES DEL ATTRIBUTO"
        // implies we should look at the Attribute Values available.

        const { data: [attributeKey] } = await query.graph({
            entity: "attribute_key",
            fields: ["id", "label", "handle", "values.*"],
            filters: { id: attributeKeyId }
        })

        if (!attributeKey || !product) {
            throw new Error("Product or Attribute Key not found")
        }

        // 3. Ensure Product Option Exists
        // We look for an option with the same Title as the Attribute Label
        let targetOption = product.options.find(o => o.title === attributeKey.label)

        if (!targetOption) {
            logger.info(`[Sync Variants] Creating missing Option: ${attributeKey.label}`)
            targetOption = await productModule.createProductOptions([
                {
                    title: attributeKey.label,
                    product_id: product.id
                }
            ]).then(res => res[0])
        }

        const updates: any[] = []

        // 4. Iterate Variants and Heal
        for (const variant of product.variants) {
            // Logic: Variant Title === Attribute Value
            // We look for an AttributeValue (from the key) that matches the Variant Title
            const matchedValue = attributeKey.values.find(v => v.value === variant.title)

            if (matchedValue) {
                // MATCH FOUND!

                // Check if variant involves this option already
                const existingOptionValue = variant.options.find(opt => opt.option_id === targetOption.id)

                if (!existingOptionValue) {
                    logger.info(`[Sync Variants] Healing Variant: ${variant.title} -> Linking to Option: ${attributeKey.label}`)

                    // We need to see if a ProductOptionValue already exists for this value string in this Option
                    // Note: ProductOptionValue is specific to the Option.
                    // But wait, ProductOptionValues are usually created/retrieved via the ProductModule service.

                    // Simplest way: Update the variant to include this option value.
                    // The Product Module `updateProductVariants` handles creating the OptionValue if strictly needed 
                    // BUT usually we pass the value string.

                    updates.push({
                        id: variant.id,
                        options: {
                            [targetOption.title]: matchedValue.value
                        },
                        // Heal SKU if missing
                        sku: variant.sku || `${product.handle}-${matchedValue.value}`
                    })
                }
            }
        }

        if (updates.length > 0) {
            await productModule.updateProductVariants(updates)
            logger.info(`[Sync Variants] Successfully updated ${updates.length} variants.`)
        } else {
            logger.info(`[Sync Variants] No variants needed healing.`)
        }

        return new StepResponse(updates, { productId, updates })
    },
    async (input, { container }) => {
        // Compensation logic (generic)
    }
)
