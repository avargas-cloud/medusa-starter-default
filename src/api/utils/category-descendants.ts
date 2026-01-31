/**
 * Utility function to recursively fetch all descendant category IDs
 * for a given parent category.
 * 
 * Used by category attribute sync to aggregate attributes from child categories.
 */

/**
 * Recursively fetch all descendant category IDs for a given parent category
 * 
 * @param categoryId - The parent category ID to start traversal from
 * @param query - Medusa Query service instance
 * @returns Array of all descendant category IDs (does not include the parent ID)
 */
export async function getAllDescendantCategoryIds(
    categoryId: string,
    query: any
): Promise<string[]> {
    const visited = new Set<string>()
    const descendants: string[] = []

    async function traverse(parentId: string) {
        // Prevent infinite loops
        if (visited.has(parentId)) return
        visited.add(parentId)

        // Find direct children
        const { data: children } = await query.graph({
            entity: "product_category",
            fields: ["id"],
            filters: { parent_category_id: parentId }
        })

        for (const child of children || []) {
            descendants.push(child.id)
            await traverse(child.id) // Recurse into grandchildren
        }
    }

    await traverse(categoryId)
    return descendants
}
