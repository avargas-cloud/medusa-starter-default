import { useQuery } from "@tanstack/react-query"
import { sdk } from "../../../../lib/sdk"

/**
 * Hook to fetch top-level categories for the filter dropdown.
 * Handles the "BY CATEGORIES" structure and applies custom priority sorting.
 * 
 * EXACT COPY from products-advanced/hooks/use-categories.tsx
 */
export const useCategories = () => {
    const { data: categoriesData, isLoading } = useQuery({
        queryKey: ["admin_categories"],
        queryFn: async () => {
            try {
                // 1. Fetch root categories
                const { product_categories: roots } = await sdk.admin.productCategory.list({
                    limit: 100,
                    parent_category_id: "null",
                    include_descendants_tree: false
                });

                // 2. Find "BY CATEGORIES" root (trying both handle and name)
                const byCategoriesRoot = roots.find(c => c.handle === "by-categories" || c.name === "BY CATEGORIES");

                let categoriesShim = roots;

                if (byCategoriesRoot) {
                    // 3. Fetch children of "BY CATEGORIES"
                    const { product_categories: children } = await sdk.admin.productCategory.list({
                        limit: 100,
                        parent_category_id: byCategoriesRoot.id,
                        include_descendants_tree: false
                    });
                    categoriesShim = children;
                }

                // 4. Custom Sorting
                const { CATEGORY_PRIORITY_LIST } = await import("../../products-advanced/category-sorting");

                return categoriesShim.sort((a, b) => {
                    const nameA = a.name.toLowerCase();
                    const nameB = b.name.toLowerCase();

                    // Find priority index (0 is highest)
                    const priorityA = CATEGORY_PRIORITY_LIST.findIndex(p => nameA.includes(p.toLowerCase()));
                    const priorityB = CATEGORY_PRIORITY_LIST.findIndex(p => nameB.includes(p.toLowerCase()));

                    // If both are in priority list, sort by their order in that list
                    if (priorityA !== -1 && priorityB !== -1) {
                        return priorityA - priorityB;
                    }

                    // If only A is in priority list, it goes first
                    if (priorityA !== -1) return -1;

                    // If only B is in priority list, it goes first
                    if (priorityB !== -1) return 1;

                    // Otherwise, sort alphabetically
                    return nameA.localeCompare(nameB);
                });
            } catch (error) {
                console.error("Failed to fetch categories:", error)
                return []
            }
        }
    });

    return {
        categories: categoriesData || [],
        isLoading
    };
};
