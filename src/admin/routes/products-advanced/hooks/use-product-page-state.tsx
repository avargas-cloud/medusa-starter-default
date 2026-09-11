import { useState } from "react";
// Type import removed as unused

// Hooks
import { useCategories } from "./use-categories";
import { useGlobalHijacker } from "./use-global-hijacker";
import { useProductSearch } from "./use-product-search";
import { useStatusToggle } from "./use-status-toggle";
import type { StatusFilter } from "../components/product-search-header";

export const useProductPageState = () => {
  // 1. Global Side Effects
  useGlobalHijacker();

  // 2. Local State
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [sortBy, setSortBy] = useState<string>("title:asc");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("published");
  const [publishingMode, setPublishingMode] = useState(false);

  // 3. Data Fetching
  const { categories, isLoading: isLoadingCategories } = useCategories();

  const {
    data,
    isLoading: isLoadingProducts,
    isError,
    error,
    ITEMS_PER_PAGE,
  } = useProductSearch({
    searchQuery,
    sortBy,
    categoryFilter,
    statusFilter,
    currentPage,
  });

  const { toggleStatus, displayStatus, pendingIds } = useStatusToggle();

  // 4. Derived State & Handlers
  const totalPages = Math.ceil((data?.totalHits || 0) / ITEMS_PER_PAGE);
  const canGoPrevious = currentPage > 0;
  const canGoNext = currentPage < totalPages - 1;

  const handlePrevious = () => setCurrentPage((prev) => prev - 1);
  const handleNext = () => setCurrentPage((prev) => prev + 1);

  // 5. Prop Groups
  return {
    headerProps: {
      searchQuery,
      setSearchQuery,
      setCurrentPage,
      categoryFilter,
      setCategoryFilter,
      categories,
      isLoadingCategories,
      statusFilter,
      setStatusFilter,
      publishingMode,
      setPublishingMode,
      sortBy,
      setSortBy,
      totalHits: data?.totalHits || 0,
      processingTime: data?.processingTime,
    },
    tableProps: {
      isLoading: isLoadingProducts,
      isError,
      error,
      data,
      searchQuery,
      publishingMode,
      pendingIds,
      displayStatus,
      onToggleStatus: toggleStatus,
    },
    paginationProps: {
      currentPage,
      totalPages,
      totalHits: data?.totalHits || 0,
      canGoPrevious,
      canGoNext,
      onPrevious: handlePrevious,
      onNext: handleNext,
      itemsPerPage: ITEMS_PER_PAGE,
    },
  };
};
