import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "@medusajs/ui";
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
    const syncMutation = useMutation({
        mutationFn: async () => {
            const response = await fetch("/admin/search/products/sync", {
                method: "POST",
                credentials: "include",
            });
            if (!response.ok) {
                throw new Error("Failed to sync products");
            }
            return response.json();
        },
        onSuccess: (data) => {
            console.log("✅ MeiliSearch sync completed:", data);
        },
        onError: (error) => {
            console.error("❌ MeiliSearch sync failed:", error);
            toast.error("Failed to sync search index", {
                description: "Search results may be outdated",
            });
        },
    });

    // Trigger sync on component mount
    useEffect(() => {
        console.log("🔄 Starting MeiliSearch sync...");
        syncMutation.mutate();
    }, []);

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
    });

    return {
        ...query,
        ITEMS_PER_PAGE
    };
};
