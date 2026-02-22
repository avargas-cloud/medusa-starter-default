import { useQuery } from "@tanstack/react-query"

export interface PriceList {
    id: string
    title: string
}

export interface FeatureFlags {
    enableDynamicPricing: boolean
    priceLists: PriceList[]
}

const DEFAULT_FLAGS: FeatureFlags = {
    enableDynamicPricing: false,
    priceLists: [],
}

/**
 * Hook to fetch feature flags from the backend.
 * Reads ENABLE_DYNAMIC_PRICING env var and available price lists.
 * staleTime: Infinity — env vars don't change at runtime (requires server restart).
 */
export const useFeatureFlags = (): FeatureFlags => {
    const { data } = useQuery<FeatureFlags>({
        queryKey: ["feature-flags"],
        queryFn: async () => {
            const response = await fetch("/admin/config/features", {
                method: "GET",
                credentials: "include",
            })
            if (!response.ok) throw new Error("Could not load feature flags")
            return response.json()
        },
        staleTime: Infinity,
        placeholderData: DEFAULT_FLAGS,
    })

    return data ?? DEFAULT_FLAGS
}
