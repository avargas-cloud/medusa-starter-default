import { useState } from "react"
import { toast } from "@medusajs/ui"

interface SortingConfig {
    subcategory_order: string[]
    product_order: string[]
}

/**
 * Hook to manage category sorting configuration state and save operations
 */
export function useCategorySorting(categoryId?: string, initialConfig?: SortingConfig) {
    const [subcategoryOrder, setSubcategoryOrder] = useState<string[]>(
        initialConfig?.subcategory_order || []
    )
    const [productOrder, setProductOrder] = useState<string[]>(
        initialConfig?.product_order || []
    )
    const [isSaving, setIsSaving] = useState(false)

    /**
     * Check if there are any changes compared to initial config
     */
    const hasChanges = () => {
        const initialSubcategories = initialConfig?.subcategory_order || []
        const initialProducts = initialConfig?.product_order || []

        // Compare arrays
        const subcategoriesChanged =
            subcategoryOrder.length !== initialSubcategories.length ||
            subcategoryOrder.some((id, index) => id !== initialSubcategories[index])

        const productsChanged =
            productOrder.length !== initialProducts.length ||
            productOrder.some((id, index) => id !== initialProducts[index])

        return subcategoriesChanged || productsChanged
    }

    /**
     * Save sorting configuration to category metadata
     * CRITICAL: Merges with existing metadata to avoid deleting filters, images, etc.
     */
    const saveSorting = async () => {
        if (!categoryId) {
            toast.error("Error", {
                description: "No category selected",
            })
            return false
        }

        // Check if there are changes
        if (!hasChanges()) {
            toast.info("No Changes", {
                description: "No changes detected. Nothing to save.",
            })
            return false
        }

        setIsSaving(true)

        try {
            // STEP 1: Fetch current category to get existing metadata
            const fetchResponse = await fetch(`/admin/product-categories/${categoryId}?fields=+metadata`, {
                credentials: "include",
            })

            if (!fetchResponse.ok) {
                throw new Error("Failed to fetch category metadata")
            }

            const categoryData = await fetchResponse.json()
            const existingMetadata = categoryData.product_category?.metadata || {}

            // console.log("[SAVE DEBUG] About to save:")
            // console.log("[SAVE DEBUG] subcategoryOrder:", subcategoryOrder)
            // console.log("[SAVE DEBUG] productOrder:", productOrder)

            // STEP 2: Update rank field for each subcategory
            // This is the PRIMARY sorting method (Medusa v2 native)
            // Using 1-based ranking (1, 2, 3...) instead of 0-based
            // console.log("[SAVE DEBUG] Updating rank fields for subcategories...")
            for (let index = 0; index < subcategoryOrder.length; index++) {
                const subcategoryId = subcategoryOrder[index]
                const rankValue = index + 1  // 1-based ranking

                try {
                    const rankResponse = await fetch(`/admin/product-categories/${subcategoryId}`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        credentials: "include",
                        body: JSON.stringify({
                            rank: rankValue
                        }),
                    })

                    if (!rankResponse.ok) {
                        // console.warn(`[SAVE DEBUG] Failed to update rank for ${subcategoryId}`)
                    } else {
                        // console.log(`[SAVE DEBUG] Updated rank for ${subcategoryId} to ${rankValue}`)
                    }
                } catch (error) {
                    // console.error(`[SAVE DEBUG] Error updating rank for ${subcategoryId}:`, error)
                }
            }

            // STEP 3: Save metadata (BACKUP only, rank is primary)
            // CRITICAL: Preserve existing order arrays to prevent data loss
            const existingSortingConfig = existingMetadata.sorting_config || {}
            const updatedMetadata = {
                ...existingMetadata,
                sorting_config: {
                    // Preserve existing subcategory_order if not modified (empty array means not touched)
                    subcategory_order: subcategoryOrder.length > 0
                        ? subcategoryOrder
                        : (existingSortingConfig.subcategory_order || []),
                    // Preserve existing product_order if not modified (empty array means not touched)
                    product_order: productOrder.length > 0
                        ? productOrder
                        : (existingSortingConfig.product_order || []),
                },
            }

            // console.log("[SAVE DEBUG] Updating metadata backup...")
            const response = await fetch(`/admin/product-categories/${categoryId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    metadata: updatedMetadata,
                }),
            })

            if (!response.ok) {
                throw new Error("Failed to save sorting configuration")
            }

            toast.success("Success", {
                description: "Sorting saved successfully (rank + metadata backup). Refreshing page...",
            })

            // Hard refresh after successful save
            setTimeout(() => {
                window.location.reload()
            }, 500)

            return true
        } catch (error: any) {
            console.error("Error saving sorting:", error)
            toast.error("Error", {
                description: error.message || "Failed to save sorting configuration",
            })
            return false
        } finally {
            setIsSaving(false)
        }
    }

    /**
     * Reset sorting to initial state
     */
    const resetSorting = () => {
        setSubcategoryOrder(initialConfig?.subcategory_order || [])
        setProductOrder(initialConfig?.product_order || [])
    }

    return {
        subcategoryOrder,
        setSubcategoryOrder,
        productOrder,
        setProductOrder,
        saveSorting,
        resetSorting,
        isSaving,
        hasChanges: hasChanges(),
    }
}
