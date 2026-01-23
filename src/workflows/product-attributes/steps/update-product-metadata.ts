
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

type UpdateMetadataInput = {
    productId: string
    variantKeys: string[]
}

export const updateProductMetadataStep = createStep(
    "update-product-metadata-step",
    async ({ productId, variantKeys }: UpdateMetadataInput, { container }) => {
        const productModule = container.resolve(Modules.PRODUCT)

        const product = await productModule.retrieveProduct(productId)
        const currentMetadata = product.metadata || {}

        const newMetadata = {
            ...currentMetadata,
            variant_attributes: variantKeys
        }

        await productModule.updateProducts(productId, {
            metadata: newMetadata
        })

        // Pass both metadata AND the ID to the rollback via the second argument
        return new StepResponse(newMetadata, { originalMetadata: currentMetadata, productId })
    },
    async (compInput, { container }) => {
        // Safe access with type casting or checking
        if (!compInput) return

        const { originalMetadata, productId } = compInput as { originalMetadata: Record<string, unknown>, productId: string }
        const productModule = container.resolve(Modules.PRODUCT)

        if (productId) {
            await productModule.updateProducts(productId, {
                metadata: originalMetadata
            })
        }
    }
)
