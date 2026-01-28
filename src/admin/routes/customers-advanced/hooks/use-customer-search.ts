import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "@medusajs/ui";
import { meiliClient } from "../../../lib/meili-client";
import { CUSTOMERS_INDEX } from "../../../lib/meili-types";
import type { MeiliCustomer } from "../../../lib/meili-types";

const ITEMS_PER_PAGE = 20;

interface UseCustomerSearchProps {
    searchQuery: string;
    customerTypeFilter: string;
    priceLevelFilter: string;
    currentPage: number;
    sortBy: string;
}

export const useCustomerSearch = ({
    searchQuery,
    customerTypeFilter,
    priceLevelFilter,
    currentPage,
    sortBy
}: UseCustomerSearchProps) => {
    const queryClient = useQueryClient();

    // Sync all customers to MeiliSearch on page load
    const syncMutation = useMutation({
        mutationFn: async () => {
            const response = await fetch("/admin/search/customers/sync", {
                method: "POST",
                credentials: "include",
            });
            if (!response.ok) {
                throw new Error("Failed to sync customers");
            }
            return response.json();
        },
        onSuccess: () => {
            console.log("✅ MeiliSearch sync completed. Invalidating cache to fetch fresh data.");
            // CRITICAL: Force re-fetch of search results after sync
            queryClient.invalidateQueries({ queryKey: ["meili-customers"] });
        },
        onError: (error) => {
            console.error("❌ MeiliSearch sync failed:", error);
            // Defer toast to avoid "Cannot update component while rendering" warning
            setTimeout(() => {
                toast.error("Failed to sync customer index", {
                    description: "Search results may be outdated",
                });
            }, 0);
        },
    });

    // Trigger sync on component mount
    // Trigger sync on component mount
    // Trigger sync on component mount
    // Trigger sync on component mount
    // DISABLED: We now use Event-Driven Sync (src/subscribers/customer-sync.ts)
    // useEffect(() => {
    //     syncMutation.mutate();
    // }, []);

    // Fetch customers from MeiliSearch
    const query = useQuery({
        queryKey: ["meili-customers", searchQuery, currentPage, customerTypeFilter, priceLevelFilter, sortBy],
        queryFn: async () => {
            const offset = currentPage * ITEMS_PER_PAGE;
            const index = meiliClient.index(CUSTOMERS_INDEX);

            // Build filter string
            const filters: string[] = [];

            if (customerTypeFilter !== "all") {
                filters.push(`customer_type = "${customerTypeFilter}"`);
            }

            if (priceLevelFilter !== "all") {
                filters.push(`price_level = "${priceLevelFilter}"`);
            }

            const searchResults = await index.search(searchQuery || "", {
                limit: ITEMS_PER_PAGE,
                offset: offset,
                sort: [sortBy],
                filter: filters.length > 0 ? filters.join(" AND ") : undefined,
                attributesToHighlight: ["company_name", "email", "list_id"],
            });

            return {
                hits: searchResults.hits as MeiliCustomer[],
                // @ts-ignore - totalHits exists in newer MeiliSearch versions/configurations
                totalHits: searchResults.totalHits || searchResults.estimatedTotalHits || 0,
                processingTime: searchResults.processingTimeMs,
            };
        },
        placeholderData: (previousData) => previousData,
        staleTime: 5000, // Consider data stale after 5 seconds
        refetchOnWindowFocus: true, // Auto-refetch when user returns to tab
        // enabled: true, // Always enable query to allow filters to work even if sync is slow
    });

    return {
        ...query,
        syncMutation,
        ITEMS_PER_PAGE
    };
};
