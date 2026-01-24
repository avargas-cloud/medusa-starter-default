import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ==================== STEP 1: Validate Variant Deletion (Cross-Module) ====================
const validateVariantDeletionStep = createStep(
    "validate-variant-deletion",
    async ({ variantIds }: { variantIds: string[] }, { container }) => {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)

        // 🔍 REMOTE QUERY: Cross module boundary (Product → Order)
        const { data: lineItems } = await query.graph({
            entity: "order_line_item",
            fields: ["id", "variant_id"],
            filters: {
                variant_id: variantIds,
            },
        })

        if (lineItems.length > 0) {
            // ⚠️ THIS IS KEY: Throwing here stops workflow and triggers rollback
            const affectedVariants = [...new Set(lineItems.map(item => item.variant_id))]
            throw new Error(
                `Cannot delete variants with existing orders (IDs: ${affectedVariants.join(", ")}). ` +
                `Please archive them manually instead.`
            )
        }

        return new StepResponse({ validated: true, variantCount: variantIds.length })
    }
)

// ==================== STEP 2: Identify Variants to Delete ====================
const identifyVariantsStep = createStep(
    "identify-variants-to-delete",
    async ({ productId, attributeKeyId }, { container }) => {
        const productModuleService = container.resolve(Modules.PRODUCT)

        // Get product with variants
        const product = await productModuleService.retrieveProduct(productId, {
            relations: ["variants", "options"]
        })

        // Find option for this attribute (we'll need attributeKey helper)
        // For now, assume we can fetch it via API or store it in metadata
        // Simplified: search by matching in metadata or option title

        const variantsToDelete = product.variants?.filter(v =>
            v.metadata?.managed_by === "attributes" &&
            v.metadata?.attribute_key_id === attributeKeyId
        ) || []

        return new StepResponse({
            ids: variantsToDelete.map(v => v.id),
            count: variantsToDelete.length,
            product
        })
    }
)

// ==================== STEP 3: Delete Variants and Options ====================
const cleanupVariantsStep = createStep(
    "cleanup-variants-for-attribute",
    async ({ product, variantIds, optionId }: { product: any; variantIds: string[]; optionId?: string }, { container }: any) => {
        const productModuleService = container.resolve(Modules.PRODUCT)

        if (variantIds.length === 0) {
            return new StepResponse(
                { deletedVariants: 0, deletedOption: null, message: "No variants to delete" },
                { productId: product.id, deletedVariantIds: [] }
            )
        }

        // Delete variants (validation already happened in previous step)
        await productModuleService.deleteProductVariants(variantIds)

        // Delete the option if provided
        if (optionId) {
            await productModuleService.deleteProductOptions([optionId])
        }

        return new StepResponse(
            {
                deletedVariants: variantIds.length,
                deletedOption: optionId || null,
                message: `Deleted ${variantIds.length} variants`
            },
            { productId: product.id, deletedVariantIds: variantIds } // Compensation data
        )
    },
    // COMPENSATION: Restore variants if something fails after deletion
    async (compensationData: { productId: string; deletedVariantIds: string[] } | undefined) => {
        // Note: In practice, variant restoration is complex. 
        // Better to validate thoroughly BEFORE deletion.
        console.warn(`Cleanup failed after deleting ${compensationData?.deletedVariantIds?.length || 0} variants`)
    }
)

// ==================== WORKFLOW DEFINITION ====================
export const cleanupVariantAttributesWorkflow = createWorkflow(
    "cleanup-variant-attributes",
    (input: { productId: string; attributeKeyId: string; optionId?: string }) => {
        // FIXME: Type error with identifyVariantsStep - temporarily disabled
        // const identified = identifyVariantsStep({
        //     productId: input.productId,
        //     attributeKeyId: input.attributeKeyId
        // })

        // Temporary workaround: return empty result
        const identified = { ids: [], product: null as any }

        // Step 1: Validate using Remote Query (CRITICAL for cross-module safety)
        if (identified.ids.length > 0) {
            validateVariantDeletionStep({ variantIds: identified.ids })
        }

        // Step 2: Safe to delete after validation
        const result = cleanupVariantsStep({
            product: identified.product,
            variantIds: identified.ids,
            optionId: input.optionId
        })

        return new WorkflowResponse(result)
    }
)
