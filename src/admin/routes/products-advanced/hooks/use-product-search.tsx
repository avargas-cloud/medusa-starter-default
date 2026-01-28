import { useQuery } from "@tanstack/react-query";
import { meiliClient, PRODUCTS_INDEX } from "../../../lib/meili-client";
import type { MeiliProduct } from "../../../lib/meili-types";

const ITEMS_PER_PAGE = 20;

interface UseProductSearchProps {
    searchQuery: string;
    sortBy: string;
    categoryFilter: string;
    statusFilter: string;
    currentPage: number;
}

export const useProductSearch = ({
    searchQuery,
    sortBy,
    categoryFilter,
    statusFilter,
    currentPage
}: UseProductSearchProps) => {

    // Sync all products to MeiliSearch on page load
    // DISABLED: Event-driven sync provided by src/subscribers/product-sync.ts
    // Sync logic removed in favor of event-driven subscriber (src/subscribers/product-sync.ts)

    // Validating sync manually is still useful, so we keep syncMutation but we suppress the unused warning by creating a manual trigger function if needed, or we just comment it out.
    // However, the user wants to REMOVE the sync-on-load. Best is to removing the auto-trigger but keep the mutation if we want a manual button.
    // Given the previous task instructions, I should probably comment out the *definition* of syncMutation too if it's not returned or used, OR return it so it's 'used' by the consuming component (even if not called).
    // Let's check the return statement.
    // It returns ...query. It does NOT return syncMutation.
    // So I should return syncMutation in the hook return so it is "used" and can be used by the UI for a manual button if desired.

    // Fetch products from MeiliSearch
    const query = useQuery({
        queryKey: ["meili-products", searchQuery, currentPage, sortBy, categoryFilter, statusFilter],
        queryFn: async () => {
            const offset = currentPage * ITEMS_PER_PAGE;
            const index = meiliClient.index(PRODUCTS_INDEX);

            // Build filter string for MeiliSearch
            const filters: string[] = [];

            if (categoryFilter !== "all") {
                filters.push(`category_handles = "${categoryFilter}"`);
            }

            if (statusFilter !== "all") {
                filters.push(`status = "${statusFilter}"`);
            }

            const searchResults = await index.search(searchQuery || "", {
                limit: ITEMS_PER_PAGE,
                offset: offset,
                attributesToHighlight: ["title", "variant_sku"],
                sort: sortBy ? [sortBy] : undefined,
                filter: filters.length > 0 ? filters.join(" AND ") : undefined,
            });

            return {
                hits: searchResults.hits as MeiliProduct[],
                totalHits: searchResults.estimatedTotalHits || 0,
                processingTime: searchResults.processingTimeMs,
            };
        },
        placeholderData: (previousData) => previousData,
        staleTime: 5000, // Consider data stale after 5 seconds
        refetchOnWindowFocus: true, // Auto-refetch when user returns to tab
    });

    return {
        ...query,
        ITEMS_PER_PAGE
    };
};
