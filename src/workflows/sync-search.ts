import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

interface SyncSearchWorkflowInput {
    id: string
    type: 'product' | 'variant'
    eventName: string
}

interface SyncSearchStepOutput {
    success: boolean
    reason?: string
    error?: any
    action?: string
    id?: string
}

export const upsertToMeiliStep = createStep(
    "upsert-to-meili-step",
    async (input: SyncSearchWorkflowInput, { container }): Promise<StepResponse<SyncSearchStepOutput>> => {
        // 1. DYNAMIC IMPORT (Fixes ESM issue)
        const { MeiliSearch } = await import("meilisearch")

        // 2. Resolve Services
        const productModule = container.resolve(Modules.PRODUCT)
        let logger: any = console
        try {
            logger = container.resolve(ContainerRegistrationKeys.LOGGER)
        } catch (e) {
            // Fallback to console if logger is missing (e.g. medusa exec)
        }

        // 3. Resolve Parent ID if it's a variant update
        let productId = input.id
        if (input.type === 'variant') {
            try {
                // Use listVariants to find parent
                const [variant] = await productModule.listProductVariants({ id: [input.id] }, { select: ["product_id"] })

                if (variant && variant.product_id) {
                    productId = variant.product_id
                    logger.info(`🔗 [Sync Workflow] Resolved Product ID ${productId} from Variant ${input.id}`)
                } else {
                    logger.warn(`⚠️ [Sync Workflow] Could not resolve Product ID for Variant ${input.id}. Skipping.`)
                    return new StepResponse({ success: false, reason: "Variant parent not found" })
                }
            } catch (err) {
                logger.error(`❌ [Sync Workflow] Error resolving variant parent: ${err}`)
                return new StepResponse({ success: false, error: err })
            }
        }

        logger.info(`⚡ [Sync Workflow] Processing ${input.eventName} for Product ID: ${productId}`)

        try {
            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST!,
                apiKey: process.env.MEILISEARCH_API_KEY!,
            })
            const index = client.index("products")

            // 4. Fetch the specific product
            const [product] = await productModule.listProducts({
                id: [productId]
            }, {
                relations: ["variants", "categories"],
                select: ["id", "title", "handle", "thumbnail", "status", "created_at", "updated_at", "variants.sku", "categories.handle"]
            })

            if (!product) {
                // If deleted, remove from index
                if (input.eventName === "product.deleted") {
                    await index.deleteDocument(productId)
                    logger.info(`🗑️ [Sync Workflow] Deleted product ${productId} from MeiliSearch`)
                    return new StepResponse({ success: true, action: "deleted" })
                }
                logger.warn(`⚠️ [Sync Workflow] Product ${productId} not found in DB. Skipping index update.`)
                return new StepResponse({ success: false, reason: "Product not found" })
            }

            // 5. Transform to MeiliSearch Format
            const meiliDocument = {
                id: product.id,
                title: product.title,
                handle: product.handle,
                thumbnail: product.thumbnail,
                status: product.status,
                variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
                category_handles: product.categories?.map((c: any) => c.handle).filter(Boolean) || [],
                created_at: new Date(product.created_at).getTime(),
                // CRITICAL FIX: Force current timestamp to prevent false "Synced Already"
                // When variant is edited, product.updated_at doesn't change in DB
                // By injecting NOW, MeiliSearch will always be "fresher" than stale DB timestamp
                updated_at: new Date().getTime(), // Always inject current time
            }

            // 6. Upsert to MeiliSearch
            await index.addDocuments([meiliDocument], { primaryKey: "id" })

            logger.info(`✅ [Sync Workflow] Successfully synced product ${product.title} (${product.id})`)
            return new StepResponse({ success: true, action: "upserted", id: product.id })

        } catch (error: any) {
            logger.error(`❌ [Sync Workflow] Failed to sync ${productId}: ${error.message}`)
            // In a workflow, throwing allows the retry mechanism to kick in!
            // But we should wrap it or let it bubble.
            // For now, let's catch and return error to stop retry loop if it's fatal?
            // User wanted retries. So we should probably throw.
            throw error
        }
    }
)

export const syncSearchWorkflow = createWorkflow(
    "sync-search-workflow",
    (input: SyncSearchWorkflowInput) => {
        const result = upsertToMeiliStep(input)
        return new WorkflowResponse(result)
    }
)
