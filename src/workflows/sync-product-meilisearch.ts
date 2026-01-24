import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * Step: Sync product to MeiliSearch
 */
const syncProductToMeiliSearchStep = createStep(
    "sync-product-to-meilisearch",
    async ({ productId }: { productId: string }, { container }) => {
        const logger = container.resolve("logger")
        const query = container.resolve("query")

        try {
            logger.info(`[MeiliSearch Workflow] Syncing product: ${productId}`)

            const { data: products } = await query.graph({
                entity: "product",
                fields: [
                    "id",
                    "title",
                    "description",
                    "handle",
                    "thumbnail",
                    "status",
                    "metadata",
                    "variants.id",
                    "variants.sku",
                ],
                filters: { id: productId },
            })

            if (!products || products.length === 0) {
                logger.warn(`[MeiliSearch Workflow] Product not found: ${productId}`)
                return new StepResponse({ synced: false })
            }

            const product = products[0]

            const { MeiliSearch } = await import("meilisearch")

            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
                apiKey: process.env.MEILISEARCH_API_KEY || "",
            })

            const index = client.index("products")

            const document = {
                id: product.id,
                title: product.title,
                description: product.description,
                handle: product.handle,
                thumbnail: product.thumbnail,
                variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
                metadata: product.metadata || {},
                metadata_material: product.metadata?.material || null,
                metadata_category: product.metadata?.category || null,
                status: product.status,
            }

            await index.addDocuments([document], { primaryKey: "id" })

            logger.info(
                `[MeiliSearch Workflow] ✅ Synced: ${product.title} | SKUs: [${document.variant_sku.join(", ")}]`
            )

            return new StepResponse({ synced: true, product: product.title })
        } catch (error: any) {
            logger.error(`[MeiliSearch Workflow] ❌ Error: ${error.message}`)
            return new StepResponse({ synced: false, error: error.message })
        }
    }
)

/**
 * Workflow: Sync product to MeiliSearch
 */
export const syncProductToMeiliSearchWorkflow = createWorkflow(
    "sync-product-to-meilisearch",
    (input: { productId: string }) => {
        const result = syncProductToMeiliSearchStep({ productId: input.productId })
        return new WorkflowResponse(result)
    }
)
