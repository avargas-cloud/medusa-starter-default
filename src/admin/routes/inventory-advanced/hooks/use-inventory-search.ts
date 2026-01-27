import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "@medusajs/ui";
import { meiliClient, INVENTORY_INDEX } from "../../../lib/meili-client";
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

    // Prevent double sync in React StrictMode (development)
    const hasSynced = useRef(false);

    // Sync all inventory items to MeiliSearch on page load
    const syncMutation = useMutation({
        mutationFn: async () => {
            const response = await fetch("/admin/search/inventory/sync", {
                method: "POST",
                credentials: "include",
            });
            if (!response.ok) {
                throw new Error("Failed to sync inventory");
            }
            return response.json();
        },
        onSuccess: () => {
            // console.log("✅ MeiliSearch inventory sync completed:", data);
        },
        onError: (error) => {
            console.error("❌ MeiliSearch inventory sync failed:", error);
            toast.error("Failed to sync search index", {
                description: "Search results may be outdated",
            });
        },
    });

    // Trigger sync on component mount (once)
    useEffect(() => {
        if (!hasSynced.current) {
            // console.log("🔄 Starting MeiliSearch inventory sync...");
            hasSynced.current = true;
            syncMutation.mutate();
        }
    }, []);

    // Fetch inventory items from MeiliSearch
    const query = useQuery({
        queryKey: ["meili-inventory", searchQuery, currentPage, sortBy, categoryFilter],
        queryFn: async () => {
            const offset = currentPage * ITEMS_PER_PAGE;
            const index = meiliClient.index(INVENTORY_INDEX);

            // Build filter string for MeiliSearch
            const filters: string[] = [];

            if (categoryFilter && categoryFilter !== "all") {
                // Filter by category handle (supports parent categories)
                filters.push(`category_handles = "${categoryFilter}"`);
            }

            // Convert sortBy format from "title:asc" to "title:asc"
            let sortArray: string[] | undefined = undefined;
            if (sortBy) {
                const [field, direction] = sortBy.split(":");
                // MeiliSearch expects format like "title:asc"
                sortArray = [`${field}:${direction}`];
            }

            const searchResults = await index.search(searchQuery || "", {
                limit: ITEMS_PER_PAGE,
                offset: offset,
                attributesToHighlight: ["title", "sku"],
                sort: sortArray,
                filter: filters.length > 0 ? filters.join(" AND ") : undefined,
            });

            return {
                hits: searchResults.hits as MeiliInventoryItem[],
                totalHits: searchResults.estimatedTotalHits || 0,
                processingTime: searchResults.processingTimeMs,
            };
        },
        placeholderData: (previousData) => previousData,
    });

    return {
        ...query,
        ITEMS_PER_PAGE
    };
};
