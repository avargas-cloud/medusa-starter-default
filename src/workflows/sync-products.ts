import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export const syncProductsToMeiliStep = createStep(
    "sync-products-to-meili-step",
    async (_, { container }) => {
        const { MeiliSearch } = await import("meilisearch")
        const query = container.resolve("query") as any

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Fetch all products with variants, categories, and full hierarchy
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "handle",
                "description",
                "thumbnail",
                "status",
                "material",
                "updated_at",
                "created_at",
                "categories.handle",
                "categories.parent_category.handle",
                "categories.parent_category.parent_category.handle", // Depth 3
                "variants.*",
                "variants.options.*",
                "variants.options.option.*",
            ],
        })

        // Transform products for MeiliSearch
        const meiliProducts = products.map((product: any) => {
            // Flatten all category handles (including parents)
            const allCategoryHandles = new Set<string>()

            product.categories?.forEach((c: any) => {
                if (c.handle) allCategoryHandles.add(c.handle)
                if (c.parent_category?.handle) allCategoryHandles.add(c.parent_category.handle)
                if (c.parent_category?.parent_category?.handle) allCategoryHandles.add(c.parent_category.parent_category.handle)
            })

            return {
                id: product.id,
                title: product.title,
                handle: product.handle,
                description: product.description || "",
                thumbnail: product.thumbnail || null,
                status: product.status,
                metadata_material: product.material || null,
                category_handles: Array.from(allCategoryHandles), // ✅ Hierarchy support
                variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
                created_at: new Date(product.created_at).getTime(),
                updated_at: new Date(product.updated_at).getTime(), // Required for sync check
            }
        })

        // Sync to MeiliSearch
        const index = client.index("products")

        if (meiliProducts.length > 0) {
            console.log("🔍 [DEBUG] First Meili Product Payload:", JSON.stringify(meiliProducts[0], null, 2))
        } else {
            console.warn("⚠️ [DEBUG] No products transformed!")
        }

        // CRITICAL: Delete all existing documents to avoid stale data
        await index.deleteAllDocuments()

        // CRITICAL: Update settings to allow filtering and sorting
        await index.updateSettings({
            displayedAttributes: [
                "id",
                "title",
                "handle",
                "thumbnail",
                "status",
                "variant_sku",
                "updated_at",
                "created_at",
                "metadata",
                "description"
            ],
            filterableAttributes: [
                "category_handles",
                "status",
                "id",
                "variant_sku"
            ],
            sortableAttributes: [
                "title",
                "status",
                "id",
                "updated_at",
                "created_at"
            ],
            searchableAttributes: [
                "title",
                "variant_sku",
                "handle",
                "description",
                "metadata_material"
            ]
        })

        const result = await index.addDocuments(meiliProducts, { primaryKey: "id" })

        // BLOCKING: Wait for MeiliSearch to finish indexing before returning
        // This ensures the frontend gets fresh results immediately after this call succeeds
        await (client as any).tasks.waitForTask(result.taskUid)

        return new StepResponse({
            success: true,
            synced: meiliProducts.length,
            taskUid: result.taskUid
        })
    }
)

export const syncProductsWorkflow = createWorkflow(
    "sync-products-workflow",
    () => {
        const result = syncProductsToMeiliStep()
        return new WorkflowResponse(result)
    }
)
