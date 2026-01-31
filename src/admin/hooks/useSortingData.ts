import { useState, useEffect } from "react"

interface Category {
    id: string
    name: string
    handle: string
    rank?: number  // Medusa v2 native rank field
    parent_category_id: string | null
    metadata?: {
        sorting_config?: {
            subcategory_order: string[]
            product_order: string[]
        }
    }
}

interface Product {
    id: string
    title: string
    handle: string
    thumbnail?: string
}

/**
 * Hook to fetch sorting-related data:
 * - All categories
 * - Subcategories for selected category
 * - Products for selected category
 */
export function useSortingData(selectedCategoryId?: string) {
    const [categories, setCategories] = useState<Category[]>([])
    const [subcategories, setSubcategories] = useState<Category[]>([])
    const [products, setProducts] = useState<Product[]>([])
    const [isLoading, setIsLoading] = useState(true)

    // Fetch all categories on mount
    useEffect(() => {
        const fetchCategories = async () => {
            try {
                const res = await fetch(`/admin/product-categories?fields=+metadata,+parent_category_id&limit=9999`, {
                    credentials: "include",
                })
                if (!res.ok) throw new Error("Failed to fetch categories")
                const data = await res.json()
                setCategories(data.product_categories || [])
            } catch (error) {
                console.error("Error fetching categories:", error)
            }
        }
        fetchCategories()
    }, [])

    // Fetch subcategories when category is selected
    useEffect(() => {
        if (!selectedCategoryId) {
            setSubcategories([])
            setProducts([])
            setIsLoading(false)
            return
        }

        const fetchSubcategories = async () => {
            setIsLoading(true)
            try {
                // UPDATED: Fetch rank field (PRIMARY sorting)
                const res = await fetch(
                    `/admin/product-categories?fields=id,name,handle,rank&parent_category_id=${selectedCategoryId}&limit=999`,
                    { credentials: "include" }
                )
                if (!res.ok) throw new Error("Failed to fetch subcategories")
                const data = await res.json()

                // CRITICAL: Sort by rank field (Medusa v2 native)
                const sorted = (data.product_categories || []).sort((a: Category, b: Category) => {
                    const rankA = a.rank ?? 999  // Fallback for categories without rank
                    const rankB = b.rank ?? 999
                    return rankA - rankB
                })

                setSubcategories(sorted)
            } catch (error) {
                console.error("Error fetching subcategories:", error)
            } finally {
                setIsLoading(false)
            }
        }
        fetchSubcategories()
    }, [selectedCategoryId])

    // Fetch products when category is selected
    useEffect(() => {
        if (!selectedCategoryId) {
            setProducts([])
            return
        }

        const fetchProducts = async () => {
            try {
                const res = await fetch(
                    `/admin/products?fields=id,title,handle,thumbnail&category_id=${selectedCategoryId}&limit=999`,
                    { credentials: "include" }
                )
                if (!res.ok) throw new Error("Failed to fetch products")
                const data = await res.json()
                setProducts(data.products || [])
            } catch (error) {
                console.error("Error fetching products:", error)
            }
        }
        fetchProducts()
    }, [selectedCategoryId])

    return {
        categories,
        subcategories,
        products,
        isLoading,
    }
}
