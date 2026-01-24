import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

// Simplified workflow - one step at a time for debugging
const createVariantsStep = createStep(
    "create-variants-simple",
    async ({ productId, variantKeys, attributes, basePrice }, { container }) => {
        const productModuleService = container.resolve(Modules.PRODUCT)
        const pricingModuleService = container.resolve(Modules.PRICING)
        const remoteLink = container.resolve("remoteLink")

        console.log("🔥 [WORKFLOW] Starting variant generation...")
        console.log("   Product ID:", productId)
        console.log("   Variant Keys:", variantKeys)
        console.log("   Attributes:", attributes?.length)

        // Get product
        const product = await productModuleService.retrieveProduct(productId, {
            relations: ["options", "variants"]
        })

        console.log("   Product retrieved:", product.title)
        console.log("   Existing options:", product.options?.length || 0)
        console.log("   Existing variants:", product.variants?.length || 0)

        // Filter attributes by variant keys
        const variantAttributes = variantKeys.map(keyId => ({
            keyId,
            label: attributes.find(a => a.attribute_key.id === keyId)?.attribute_key?.label || "Unknown",
            values: attributes.filter(a => a.attribute_key.id === keyId)
        }))

        console.log("   Variant attributes:", variantAttributes)

        // Validate
        for (const attr of variantAttributes) {
            if (attr.values.length < 2) {
                throw new Error(`Attribute ${attr.label} needs at least 2 values`)
            }
        }

        // Calculate combinations
        const combinations = generateCartesianProduct(variantAttributes)
        console.log(`   Total combinations: ${combinations.length}`)

        if (combinations.length > 100) {
            throw new Error(`Too many combinations: ${combinations.length}. Max 100.`)
        }

        const createdOptions: string[] = []
        const createdVariants: any[] = []
        const createdPriceSets: string[] = []

        try {
            // Step 1: Create options
            for (const attr of variantAttributes) {
                const optionTitle = attr.label
                const optionValues = attr.values.map(v => v.value)

                const existingOption = product.options?.find(o => o.title === optionTitle)

                if (!existingOption) {
                    console.log(`   Creating option: ${optionTitle}`)
                    const newOptions = await productModuleService.createProductOptions([{
                        product_id: productId,
                        title: optionTitle,
                        values: optionValues
                    }])
                    createdOptions.push(newOptions[0].id)
                    console.log(`   ✅ Option created: ${newOptions[0].id}`)
                }
            }

            // Step 2: Create variants
            const variantsData = combinations.map(combo => ({
                product_id: productId,
                title: combo.map(v => v.value).join(" / "),
                options: combo.reduce((acc, v) => {
                    acc[v.attribute_key.label] = v.value
                    return acc
                }, {} as Record<string, string>),
                metadata: {
                    managed_by: "attributes",
                    variation: combo.map(v => slugify(v.value)).join("-")
                },
                manage_inventory: false
            }))

            console.log(`   Creating ${variantsData.length} variants...`)
            const newVariants = await productModuleService.createProductVariants(productId, variantsData)
            createdVariants.push(...newVariants)
            console.log(`   ✅ Created ${newVariants.length} variants`)

            // Step 3: Create prices
            for (const variant of newVariants) {
                console.log(`   Creating price for variant: ${variant.id}`)
                const priceSet = await pricingModuleService.createPriceSets({
                    prices: [{
                        amount: basePrice || 0,
                        currency_code: "usd",
                        rules: {}
                    }]
                })
                createdPriceSets.push(priceSet.id)

                await remoteLink.create({
                    [Modules.PRODUCT]: { variant_id: variant.id },
                    [Modules.PRICING]: { price_set_id: priceSet.id }
                })
                console.log(`   ✅ Price set created: ${priceSet.id}`)
            }

            console.log("🎉 [WORKFLOW] Variant generation complete!")

            return new StepResponse({
                variantsCreated: createdVariants.length,
                priceSetsCreated: createdPriceSets.length,
                createdOptions,
                createdVariants: createdVariants.map(v => v.id),
                createdPriceSets
            })

        } catch (error) {
            console.error("❌ [WORKFLOW] Error:", error)
            // Rollback on error
            if (createdPriceSets.length > 0) {
                await pricingModuleService.deletePriceSets(createdPriceSets)
            }
            if (createdVariants.length > 0) {
                await productModuleService.deleteProductVariants(createdVariants.map(v => v.id))
            }
            if (createdOptions.length > 0) {
                await productModuleService.deleteProductOptions(createdOptions)
            }
            throw error
        }
    }
)

export const generateVariantsWorkflow = createWorkflow(
    "generate-variants-from-attributes",
    function (input: {
        productId: string
        variantKeys: string[]
        attributes: any[]
        basePrice?: number
    }) {
        return new WorkflowResponse({
            variantsCreated: 0,
            priceSetsCreated: 0
        })
    }
)

// Helper functions
function generateCartesianProduct(variantAttributes: any[]) {
    const groups = variantAttributes.map(attr => attr.values)
    return groups.reduce((acc, group) =>
        acc.flatMap(combo => group.map(val => [...combo, val])),
        [[]]
    ).filter(combo => combo.length === variantAttributes.length)
}

function slugify(text: string): string {
    return text.toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-')
        .replace(/^-+|-+$/g, '')
}
