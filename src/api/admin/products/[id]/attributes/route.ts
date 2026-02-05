
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { updateProductAttributesWorkflow } from "../../../../../workflows/product-attributes/update-product-attributes"
import { safeDeleteOptionWorkflow } from "../../../../../workflows/variant-cleanup"
import { Modules } from "@medusajs/framework/utils"
import type { PRODUCT_ATTRIBUTES_MODULE } from "../../../../../modules/product-attributes"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")
    const knex = req.scope.resolve("__pg_connection__")
    const { id } = req.params

    try {
        // Use RAW SQL to avoid query.graph caching issues
        // This ensures we get the LATEST data immediately after workflow completes
        const links = await knex("product_product_productattributes_attribute_value")
            .select("attribute_value_id")
            .where("product_id", id)
            .whereNull("deleted_at")  // ✅ Filter out soft-deleted links

        const ids = links.map((l: any) => l.attribute_value_id)

        console.log(`📊 [API GET] Product ${id}: Found ${ids.length} attribute links`)

        if (ids.length === 0) {
            return res.json({ attributes: [] })
        }

        const { data: attributes } = await query.graph({
            entity: "attribute_value",
            fields: [
                "id",
                "value",
                "attribute_key.id",
                "attribute_key.label",
                "attribute_key.handle",
            ],
            filters: { id: ids }
        })

        console.log(`✅ [API GET] Returning ${attributes.length} attributes`)

        res.json({ attributes })
        return
    } catch (error) {
        console.error("💥 [API ERROR] GET /attributes:", error)
        res.status(500).json({
            message: "Failed to fetch product attributes",
            error: (error as Error).message
        })
    }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { value_ids, variant_keys } = req.body as { value_ids: string[], variant_keys: string[] }
    const { id: productId } = req.params

    console.log("🔥 [API] POST /attributes:", { productId, value_ids, variant_keys })

    try {
        const productService = req.scope.resolve(Modules.PRODUCT)
        const pricingService = req.scope.resolve(Modules.PRICING)
        const remoteLink = req.scope.resolve("remoteLink")
        const query = req.scope.resolve("query")

        // Get current variant keys
        const product = await productService.retrieveProduct(productId)
        const previousVariantKeys = (product.metadata?.variant_attributes as string[]) || []

        console.log("   Previous:", previousVariantKeys)
        console.log("   New:", variant_keys)


        // Step 1: Update attributes and metadata
        try {
            console.log("   🔄 Executing updateProductAttributesWorkflow...")
            await updateProductAttributesWorkflow(req.scope).run({
                input: {
                    productId,
                    valueIds: value_ids || [],
                    variantKeys: variant_keys || [],
                }
            })
            console.log("   ✅ Workflow completed successfully")
        } catch (workflowError: any) {
            console.error("   💥 WORKFLOW ERROR:", {
                message: workflowError.message,
                stack: workflowError.stack,
                details: workflowError
            })
            throw workflowError
        }

        const newKeys = variant_keys || []
        const removedKeys = previousVariantKeys.filter(k => !newKeys.includes(k))
        const addedKeys = newKeys.filter(k => !previousVariantKeys.includes(k))

        // Step 2: Cleanup removed variant attributes using Safe Deletion Workflow
        if (removedKeys.length > 0) {
            console.log("   🧹 Starting safe cleanup for removed keys:", removedKeys)

            for (const keyId of removedKeys) {
                // Get attribute key data
                const { data: keyData } = await query.graph({
                    entity: "attribute_key",
                    fields: ["id", "label"],
                    filters: { id: keyId }
                })

                if (keyData?.[0]) {
                    const keyLabel = keyData[0].label
                    console.log(`   Processing removal of: ${keyLabel}`)

                    // Find the option to delete
                    const productWithOptions = await productService.retrieveProduct(productId, {
                        relations: ["options"]
                    })
                    const optionToDelete = productWithOptions.options?.find(o => o.title === keyLabel)

                    if (optionToDelete) {
                        try {
                            // Use Safe Deletion Workflow
                            const workflowResult = await safeDeleteOptionWorkflow(req.scope).run({
                                input: {
                                    optionId: optionToDelete.id
                                }
                            })

                            const result = workflowResult.result

                            if (result.protectedVariants.length > 0) {
                                // Some variants have sales - cannot delete
                                console.error(`   ⚠️ PROTECTED: ${result.protectedVariants.length} variants have orders`)
                                return res.status(400).json({
                                    error: "Cannot disable variant attribute",
                                    message: `Some variants have existing orders and cannot be deleted.`,
                                    protectedVariants: result.protectedVariants,
                                    details: result.protectedVariants.map(pv =>
                                        `Variant ${pv.variantId}: ${pv.orderCount} order(s)`
                                    ).join(", ")
                                })
                            }

                            console.log(`   ✅ Safely deleted option "${keyLabel}" and ${result.variantsDeleted} variant(s)`)

                        } catch (error: any) {
                            console.error(`   💥 Error in safe deletion:`, (error as Error).message)
                            return res.status(500).json({
                                error: "Deletion failed",
                                message: (error as Error).message
                            })
                        }
                    } else {
                        console.log(`   ℹ️ Option "${keyLabel}" not found, skipping`)
                    }
                }
            }
        }

        // Step 3: Generate variants for NEWLY ADDED keys only
        if (addedKeys.length > 0) {
            console.log(`   🎨 Generating variants for ${addedKeys.length} new key(s)...`)

            // Fetch attributes
            const { data: links } = await query.graph({
                entity: "product_attribute_value",
                fields: ["attribute_value_id"],
                filters: { product_id: productId }
            })

            const attributeIds = links.map((l: any) => l.attribute_value_id)
            const { data: attributes } = await query.graph({
                entity: "attribute_value",
                fields: ["id", "value", "attribute_key.id", "attribute_key.label", "attribute_key.handle"],
                filters: { id: attributeIds }
            })

            // Get product with options
            const productWithOptions = await productService.retrieveProduct(productId, {
                relations: ["options", "variants"]
            })

            // Build variant attributes for NEWLY ADDED keys only
            const variantAttributes = addedKeys.map(keyId => ({
                keyId,
                label: attributes.find(a => a.attribute_key.id === keyId)?.attribute_key?.label || "Unknown",
                values: attributes.filter(a => a.attribute_key.id === keyId)
            }))

            // Validate
            for (const attr of variantAttributes) {
                if (attr.values.length < 2) {
                    return res.status(400).json({
                        message: `Attribute "${attr.label}" needs at least 2 values`
                    })
                }
            }

            // Create options if needed
            for (const attr of variantAttributes) {
                const optionTitle = attr.label
                const optionValues = attr.values.map(v => v.value)
                const existingOption = productWithOptions.options?.find(o => o.title === optionTitle)

                if (!existingOption) {
                    console.log(`   Creating option: ${optionTitle}`)
                    await productService.createProductOptions([{
                        product_id: productId,
                        title: optionTitle,
                        values: optionValues
                    }])
                }
            }

            // Generate combinations
            const combinations = generateCartesianProduct(variantAttributes.map(a => a.values))
            console.log(`   Combinations: ${combinations.length}`)

            if (combinations.length > 100) {
                return res.status(400).json({
                    message: `Too many combinations: ${combinations.length}. Max 100.`
                })
            }

            // Create variants (skip duplicates)
            const existingVariants = productWithOptions.variants || []

            const variantsToCreate = combinations
                .map(combo => {
                    const optionsMap = combo.reduce((acc: any, v: any) => {
                        acc[v.attribute_key.label] = v.value
                        return acc
                    }, {} as Record<string, string>)

                    // Check if variant with these exact options already exists
                    const isDuplicate = existingVariants.some(variant => {
                        if (!variant.options || variant.options.length === 0) return false

                        // Compare all option values
                        const variantOptions = variant.options.reduce((acc, opt) => {
                            acc[opt.option?.title || ''] = opt.value
                            return acc
                        }, {} as Record<string, string>)

                        return Object.keys(optionsMap).every(key =>
                            variantOptions[key] === optionsMap[key]
                        )
                    })

                    if (isDuplicate) {
                        console.log(`   ⏭️  Skipping duplicate: ${combo.map(v => v.value).join(" / ")}`)
                        return null
                    }

                    return {
                        product_id: productId,
                        title: combo.map(v => v.value).join(" / "),
                        options: optionsMap,
                        metadata: {
                            managed_by: "attributes",
                            variation: combo.map(v => slugify(v.value)).join("-")
                        },
                        manage_inventory: false
                    }
                })
                .filter(v => v !== null) // Remove duplicates

            if (variantsToCreate.length === 0) {
                console.log(`   ℹ️  All variants already exist, skipping creation`)
                return res.json({
                    message: "Attributes updated successfully (no new variants needed)",
                    variantsCreated: 0
                })
            }

            const newVariants = await productService.createProductVariants(variantsToCreate)
            console.log(`   ✅ Created ${newVariants.length} new variants (skipped ${combinations.length - newVariants.length} duplicates)`)

            // Create prices
            for (const variant of newVariants) {
                const priceSet = await pricingService.createPriceSets({
                    prices: [{
                        amount: 0,
                        currency_code: "usd",
                        rules: {}
                    }]
                })

                await remoteLink.create({
                    [Modules.PRODUCT]: { variant_id: variant.id },
                    [Modules.PRICING]: { price_set_id: priceSet.id }
                })
            }

            console.log("   🎉 Complete!")

            return res.json({
                message: "Attributes and variants updated successfully",
                variantsCreated: newVariants.length
            })
        }

        res.json({ message: "Attributes updated successfully" })
    } catch (error: any) {
        console.error("💥 [API ERROR]:", error)
        res.status(500).json({
            message: "Failed to update attributes",
            error: (error as Error).message,
            stack: error.stack
        })
    }
}

// Helper functions
function generateCartesianProduct(groups: any[][]) {
    return groups.reduce((acc, group) =>
        acc.flatMap(combo => group.map(val => [...combo, val])),
        [[]]
    ).filter(combo => combo.length === groups.length)
}

function slugify(text: string): string {
    return text.toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-')
        .replace(/^-+|-+$/g, '')
}
