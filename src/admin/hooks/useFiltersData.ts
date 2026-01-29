import { useQuery } from "@tanstack/react-query"

interface Category {
    id: string
    name: string
    handle: string
    parent_category_id: string | null
    metadata?: {
        available_attributes?: string[]
        filter_config?: {
            override_inheritance: boolean
            active_filters: string[]
        }
    }
}

interface AttributeKey {
    id: string
    label: string
    handle: string
}

export function useFiltersData() {
    // Fetch all categories
    const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
        queryKey: ["product_categories"],
        queryFn: async () => {
            const res = await fetch(`/admin/product-categories?fields=+metadata,+parent_category_id&limit=9999`, {
                credentials: "include",
            })
            if (!res.ok) throw new Error("Failed to fetch categories")
            const data = await res.json()
            return data.product_categories || []
        },
    })

    // Fetch all attribute keys
    const { data: attributesData, isLoading: attributesLoading } = useQuery({
        queryKey: ["attribute_keys"],
        queryFn: async () => {
            const res = await fetch(`/admin/attributes`, {
                credentials: "include",
            })
            if (!res.ok) throw new Error("Failed to fetch attributes")
            return res.json()
        },
    })

    const categories: Category[] = categoriesData || []
    const attributes: AttributeKey[] = attributesData?.attribute_keys || []

    return {
        categories,
        attributes,
        isLoading: categoriesLoading || attributesLoading,
    }
}
