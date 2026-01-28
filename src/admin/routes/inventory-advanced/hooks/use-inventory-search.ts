import { useQuery } from "@tanstack/react-query";
import type { MeiliInventoryItem } from "../../../lib/meili-types";

const ITEMS_PER_PAGE = 20;

interface UseInventorySearchProps {
    searchQuery: string;
    sortBy: string;
    categoryFilter: string | null;
    currentPage: number;
}

export const useInventorySearch = ({
    searchQuery,
    sortBy,
    categoryFilter,
    currentPage
}: UseInventorySearchProps) => {
    // Sync logic removed in favor of event-driven subscriber (src/subscribers/inventory-sync.ts)

    // Trigger sync on component mount (once)
    // DISABLED: Event-driven sync provided by src/subscribers/inventory-sync.ts
    // useEffect(() => {
    //     if (!hasSynced.current) {
    //         // console.log("🔄 Starting MeiliSearch inventory sync...");
    //         hasSynced.current = true;
    //         syncMutation.mutate();
    //     }
    // }, []);

    // Fetch inventory items via Server Proxy (Bypasses CORS)
    const query = useQuery({
        queryKey: ["meili-inventory", searchQuery, currentPage, sortBy, categoryFilter],
        queryFn: async () => {
            const offset = currentPage * ITEMS_PER_PAGE;

            // Build filter string
            const filters: string[] = [];
            if (categoryFilter && categoryFilter !== "all") {
                filters.push(`category_handles = "${categoryFilter}"`);
            }

            // Convert sortBy format
            let sortArray: string[] | undefined = undefined;
            if (sortBy) {
                const [field, direction] = sortBy.split(":");
                sortArray = [`${field}:${direction}`];
            }

            // Call our new Proxy Route
            const response = await fetch("/admin/search/inventory/query", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    q: searchQuery || "",
                    offset,
                    limit: ITEMS_PER_PAGE,
                    filter: filters.length > 0 ? filters.join(" AND ") : undefined,
                    sort: sortArray
                }),
                credentials: "include",
            });

            if (!response.ok) {
                throw new Error("Search request failed");
            }

            const searchResults = await response.json();

            return {
                hits: searchResults.hits as MeiliInventoryItem[],
                totalHits: searchResults.estimatedTotalHits || searchResults.nbHits || 0,
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
