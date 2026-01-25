import {
    Container,
    Heading,
    Table,
    Badge,
    Input,
    Button,
    Text,
    Toaster,
    toast,
    Select,
} from "@medusajs/ui";
import { MagnifyingGlass, TagSolid } from "@medusajs/icons";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { meiliClient, PRODUCTS_INDEX } from "../../lib/meili-client";
import type { MeiliProduct } from "../../lib/meili-types";
import "../../styles/scrollbar-fix.css"; // Force scrollbar visibility

/**
 * Advanced Product Search Page
 * 
 * Custom UI Route that provides MeiliSearch-powered product search.
 * Features:
 * - Real-time search by SKU, title, description, handle
 * - Typo tolerance and fuzzy matching
 * - Flattened variant SKU search (returns parent product)
 * - Pagination support
 * - Seamless navigation to native edit page
 * - Auto-sync on page load to ensure fresh data
 */

const ITEMS_PER_PAGE = 20;

const ProductSearchPage = () => {
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState("");
    const [currentPage, setCurrentPage] = useState(0);
    const [sortBy, setSortBy] = useState<string>("title:asc"); // New state for sorting
    const [categoryFilter, setCategoryFilter] = useState<string>("all"); // New state for category


    // GLOBAL HIJACKER: Intercept native Products button clicks
    useEffect(() => {
        const hijackProductsClick = (e: Event) => {
            const target = e.target as HTMLElement;
            const link = target.closest('a[href="/app/products"]') as HTMLAnchorElement;

            if (link) {
                // console.log("🎯 Intercepted Products click!");

                // Prevent default navigation
                e.preventDefault();
                e.stopPropagation();

                // Use History API for SPA navigation (no reload)
                window.history.pushState({}, '', '/app/products-advanced');

                // Trigger React Router navigation event
                window.dispatchEvent(new PopStateEvent('popstate'));
            }
        };

        // Listen with capture to intercept BEFORE React Router
        document.addEventListener("click", hijackProductsClick as EventListener, true);
        // console.log("✅ Global Products hijacker active (SPA mode)");

        return () => {
            document.removeEventListener("click", hijackProductsClick as EventListener, true);
        };
    }, []); // Run once on mount, stays active forever

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
    }, []); // Empty dependency array = run once on mount

    // Fetch products from MeiliSearch
    const { data, isLoading, isError, error } = useQuery({
        queryKey: ["meili-products", searchQuery, currentPage, sortBy, categoryFilter],
        queryFn: async () => {
            const offset = currentPage * ITEMS_PER_PAGE;
            const index = meiliClient.index(PRODUCTS_INDEX);

            // Build filter string for MeiliSearch
            const filter = categoryFilter !== "all" ? `category_handles = "${categoryFilter}"` : undefined;

            const searchResults = await index.search(searchQuery || "", {
                limit: ITEMS_PER_PAGE,
                offset: offset,
                attributesToHighlight: ["title", "variant_sku"],
                sort: sortBy ? [sortBy] : undefined, // ✅ Add sorting
                filter: filter, // ✅ Real category filtering
            });

            return {
                hits: searchResults.hits as MeiliProduct[],
                totalHits: searchResults.estimatedTotalHits || 0,
                processingTime: searchResults.processingTimeMs,
            };
        },
        placeholderData: (previousData) => previousData,
    });

    // Handle row click - navigate to native edit page
    const handleRowClick = useCallback(
        (product: MeiliProduct) => {
            navigate(`/products/${product.id}`);
        },
        [navigate]
    );

    // Handle search input change
    const handleSearchChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            setSearchQuery(e.target.value);
            setCurrentPage(0); // Reset to first page on new search
        },
        []
    );

    // Handle category quick search
    const handleCategoryChange = useCallback(
        (category: string) => {
            setCategoryFilter(category);
            // Don't modify search query, use MeiliSearch filter instead
            setCurrentPage(0);
        },
        []
    );

    // Pagination handlers
    const totalPages = Math.ceil((data?.totalHits || 0) / ITEMS_PER_PAGE);
    const canGoPrevious = currentPage > 0;
    const canGoNext = currentPage < totalPages - 1;

    const handlePrevious = () => {
        if (canGoPrevious) {
            setCurrentPage((prev) => prev - 1);
        }
    };

    const handleNext = () => {
        if (canGoNext) {
            setCurrentPage((prev) => prev + 1);
        }
    };

    return (
        <>
            <Toaster />
            <Container className="divide-y p-0 h-full flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b">
                    <div>
                        <Heading level="h1" className="text-ui-fg-base">
                            Products
                        </Heading>
                        <Text size="small" className="text-ui-fg-subtle mt-1">
                            Search by SKU, title, description, or handle
                        </Text>
                    </div>

                    {/* Category Quick Search */}
                    <Select value={categoryFilter} onValueChange={handleCategoryChange}>
                        <Select.Trigger className="w-[220px]">
                            <Select.Value placeholder="Category Quick Search" />
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="all">All Categories</Select.Item>
                            <Select.Item value="cables">CABLES</Select.Item>
                            <Select.Item value="ceiling-lights">CEILING LIGHTS</Select.Item>
                            <Select.Item value="controllers">CONTROLLERS</Select.Item>
                            <Select.Item value="led-channels">LED Channels</Select.Item>
                            <Select.Item value="led-drivers">LED Drivers</Select.Item>
                            <Select.Item value="led-neon">LED NEON</Select.Item>
                            <Select.Item value="led-strips">LED STRIPS</Select.Item>
                            <Select.Item value="linear-lighting-accessories">LINEAR LIGHTING ACCESSORIES</Select.Item>
                            <Select.Item value="sign-backlighting">SIGN &amp; BACKLIGHTING</Select.Item>
                            <Select.Item value="switches-dimmers-outlets">SWITCHES, DIMMERS &amp;amp; OUTLETS</Select.Item>
                            <Select.Item value="underground-lights">UNDERGROUND LIGHTS</Select.Item>
                        </Select.Content>
                    </Select>
                </div>

                {/* Search Bar */}
                <div className="px-6 py-4 border-b bg-ui-bg-subtle">
                    <div className="flex items-center gap-3">
                        <div className="flex-1 relative">
                            <Input
                                type="search"
                                placeholder="Search products... (e.g., SKU-123, name, etc.)"
                                value={searchQuery}
                                onChange={handleSearchChange}
                                autoFocus
                                className="w-full"
                            />
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-ui-fg-muted">
                                <MagnifyingGlass />
                            </div>
                        </div>

                        {/* Sort Dropdown */}
                        <Select value={sortBy} onValueChange={(value) => {
                            setSortBy(value);
                            setCurrentPage(0); // Reset to first page
                        }}>
                            <Select.Trigger className="w-[180px]">
                                <Select.Value placeholder="Sort by..." />
                            </Select.Trigger>
                            <Select.Content>
                                <Select.Item value="title:asc">Title A-Z</Select.Item>
                                <Select.Item value="title:desc">Title Z-A</Select.Item>
                                <Select.Item value="status:asc">Status: Draft First</Select.Item>
                                <Select.Item value="status:desc">Status: Published First</Select.Item>
                                <Select.Item value="id:desc">Newest First</Select.Item>
                                <Select.Item value="id:asc">Oldest First</Select.Item>
                            </Select.Content>
                        </Select>

                        {data && (
                            <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
                                {data.totalHits} results ({data.processingTime}ms)
                            </Text>
                        )}
                    </div>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-auto">
                    {isError && (
                        <div className="p-6 text-center">
                            <Text className="text-ui-fg-error">
                                Error loading products: {error instanceof Error ? error.message : "Unknown error"}
                            </Text>
                        </div>
                    )}

                    {!isError && (
                        <Table>
                            <Table.Header>
                                <Table.Row>
                                    <Table.HeaderCell className="w-16">Image</Table.HeaderCell>
                                    <Table.HeaderCell>Title</Table.HeaderCell>
                                    <Table.HeaderCell>Handle</Table.HeaderCell>
                                    <Table.HeaderCell>SKUs</Table.HeaderCell>
                                    <Table.HeaderCell className="w-32">Material</Table.HeaderCell>
                                    <Table.HeaderCell className="w-32">Status</Table.HeaderCell>
                                </Table.Row>
                            </Table.Header>

                            <Table.Body>
                                {isLoading ? (
                                    <Table.Row>
                                        <Table.Cell className="text-center py-8">
                                            <Text className="text-ui-fg-subtle">Loading products...</Text>
                                        </Table.Cell>
                                    </Table.Row>
                                ) : data?.hits.length === 0 ? (
                                    <Table.Row>
                                        <Table.Cell className="text-center py-8">
                                            <Text className="text-ui-fg-subtle">
                                                {searchQuery ? "No products found" : "Type to search products"}
                                            </Text>
                                        </Table.Cell>
                                    </Table.Row>
                                ) : (
                                    data?.hits.map((product) => (
                                        <Table.Row
                                            key={product.id}
                                            onClick={() => handleRowClick(product)}
                                            className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                        >
                                            {/* Thumbnail */}
                                            <Table.Cell>
                                                <div className="h-10 w-10 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
                                                    {product.thumbnail ? (
                                                        <img
                                                            src={product.thumbnail}
                                                            alt={product.title}
                                                            className="h-full w-full object-cover"
                                                        />
                                                    ) : (
                                                        <TagSolid className="text-ui-fg-muted" />
                                                    )}
                                                </div>
                                            </Table.Cell>

                                            {/* Title */}
                                            <Table.Cell>
                                                <Text weight="plus" className="text-ui-fg-base">
                                                    {product.title}
                                                </Text>
                                            </Table.Cell>

                                            {/* Handle */}
                                            <Table.Cell>
                                                <Text size="small" className="text-ui-fg-subtle font-mono">
                                                    {product.handle}
                                                </Text>
                                            </Table.Cell>

                                            {/* Variant SKUs */}
                                            <Table.Cell>
                                                <div className="flex gap-1 flex-wrap max-w-[250px]">
                                                    {product.variant_sku?.slice(0, 3).map((sku, idx) => (
                                                        <Badge key={idx} size="small" className="font-mono">
                                                            {sku}
                                                        </Badge>
                                                    ))}
                                                    {product.variant_sku?.length > 3 && (
                                                        <Badge size="small" className="bg-ui-bg-subtle">
                                                            +{product.variant_sku.length - 3}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </Table.Cell>

                                            {/* Material */}
                                            <Table.Cell>
                                                {product.metadata_material && (
                                                    <Badge size="small">
                                                        {product.metadata_material}
                                                    </Badge>
                                                )}
                                            </Table.Cell>

                                            {/* Status */}
                                            <Table.Cell>
                                                <Badge
                                                    size="small"
                                                    color={product.status === "published" ? "green" : "grey"}
                                                    className="capitalize"
                                                >
                                                    {product.status}
                                                </Badge>
                                            </Table.Cell>
                                        </Table.Row>
                                    ))
                                )}
                            </Table.Body>
                        </Table>
                    )}
                </div>

                {/* Pagination */}
                {data && data.totalHits > ITEMS_PER_PAGE && (
                    <div className="flex items-center justify-between px-6 py-4 border-t">
                        <Text size="small" className="text-ui-fg-subtle">
                            Page {currentPage + 1} of {totalPages} ({data.totalHits} total products)
                        </Text>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={handlePrevious}
                                disabled={!canGoPrevious}
                            >
                                Previous
                            </Button>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={handleNext}
                                disabled={!canGoNext}
                            >
                                Next
                            </Button>
                        </div>
                    </div>
                )}
            </Container>
        </>
    );
};

export default ProductSearchPage;
