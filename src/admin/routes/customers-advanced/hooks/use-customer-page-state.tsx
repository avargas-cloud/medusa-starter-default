import { useState, useRef, useEffect } from "react";
import { useCustomerSearch } from "./use-customer-search";
import { useGlobalHijacker } from "./use-global-hijacker";

export const useCustomerPageState = () => {
    // Global Hijackers
    useGlobalHijacker();

    // StrictMode Guard for Sync
    const hasSynced = useRef(false);

    // State
    const [searchQuery, setSearchQuery] = useState("");
    const [currentPage, setCurrentPage] = useState(0);
    const [sortBy, setSortBy] = useState<string>("company_name:asc");
    const [customerTypeFilter, setCustomerTypeFilter] = useState<string>("all");
    const [priceLevelFilter, setPriceLevelFilter] = useState<string>("all");

    // Data Fetching
    const {
        data,
        isLoading,
        isError,
        error,
        syncMutation,
        ITEMS_PER_PAGE
    } = useCustomerSearch({
        searchQuery,
        customerTypeFilter,
        priceLevelFilter,
        currentPage,
        sortBy
    });

    // Trigger Blocking Sync on Mount (Once)
    // Trigger Blocking Sync on Mount (Once)
    // DISABLED: Event-driven sync provided by src/subscribers/customer-sync.ts
    // useEffect(() => {
    //     if (hasSynced.current) return;
    //     hasSynced.current = true;
    //     syncMutation.mutate();
    // }, []);

    // Derived State
    const totalPages = Math.ceil((data?.totalHits || 0) / ITEMS_PER_PAGE);
    const canGoPrevious = currentPage > 0;
    const canGoNext = currentPage < totalPages - 1;

    // Handlers
    const handlePrevious = () => setCurrentPage((prev) => prev - 1);
    const handleNext = () => setCurrentPage((prev) => prev + 1);

    return {
        headerProps: {
            searchQuery,
            setSearchQuery,
            customerTypeFilter,
            setCustomerTypeFilter,
            priceLevelFilter,
            setPriceLevelFilter,
            sortBy,
            setSortBy,
            totalHits: data?.totalHits || 0,
            isSyncing: syncMutation.isPending
        },
        tableProps: {
            isLoading: isLoading || syncMutation.isPending, // Blocking Sync behavior
            isError,
            error,
            data,
            searchQuery
        },
        paginationProps: {
            currentPage,
            totalPages,
            totalHits: data?.totalHits || 0,
            canGoPrevious,
            canGoNext,
            onPrevious: handlePrevious,
            onNext: handleNext,
            itemsPerPage: ITEMS_PER_PAGE
        }
    };
};
