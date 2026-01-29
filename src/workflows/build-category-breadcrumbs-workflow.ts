import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"

type BreadcrumbItem = {
    id: string
    name: string
    handle: string
}

/**
 * Step: Build Category Hierarchy
 * 
 * Recursively traverses category parent chain to build breadcrumb array
 * from root ("By Categories") to the target category.
 */
const buildHierarchyStep = createStep(
    "build-category-hierarchy",
    async ({ categoryId }: { categoryId: string }, { container }) => {
        const query = container.resolve("query")
        const crumbs: BreadcrumbItem[] = []
        let currentId: string | null = categoryId

        // Safety limit to prevent infinite loops (max 10 levels deep)
        let depth = 0
        const MAX_DEPTH = 10

        while (currentId && depth < MAX_DEPTH) {
            const { data } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "handle", "parent_category_id"],
                filters: { id: currentId }
            })

            // If category not found, break
            if (!data?.[0]) {
                console.warn(`[Breadcrumbs] Category not found: ${currentId}`)
                break
            }

            const category = data[0]

            // Add to beginning of array (we're traversing from child to root)
            crumbs.unshift({
                id: category.id,
                name: category.name,
                handle: category.handle
            })

            currentId = category.parent_category_id
            depth++
        }

        if (depth === MAX_DEPTH) {
            console.warn(`[Breadcrumbs] Max depth reached for category ${categoryId}, possible circular reference`)
        }

        return new StepResponse(crumbs)
    }
)

/**
 * Workflow: Build Category Breadcrumbs
 * 
 * Input: { categoryId: string }
 * Output: Array<{ id: string, name: string, handle: string }>
 * 
 * Usage:
 * const { result } = await buildCategoryBreadcrumbsWorkflow(scope)
 *   .run({ input: { categoryId: "pcat_xxx" } })
 */
export const buildCategoryBreadcrumbsWorkflow = createWorkflow(
    "build-category-breadcrumbs",
    ({ categoryId }: { categoryId: string }) => {
        const breadcrumbs = buildHierarchyStep({ categoryId })
        return new WorkflowResponse(breadcrumbs)
    }
)
