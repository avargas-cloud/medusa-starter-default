import { Heading, Text, Input, Select } from "@medusajs/ui";
import { MagnifyingGlass } from "@medusajs/icons";
import { SyncStatusButton } from "../../../components/shared/sync-status-button";
import { useQueryClient } from "@tanstack/react-query";

interface ProductSearchHeaderProps {
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    setCurrentPage: (page: number) => void;
    categoryFilter: string;
    setCategoryFilter: (category: string) => void;
    categories: any[];
    isLoadingCategories: boolean;
    statusFilter: string;
    setStatusFilter: (status: "all" | "published") => void;
    sortBy: string;
    setSortBy: (sort: string) => void;
    totalHits: number;
    processingTime?: number;
}

export const ProductSearchHeader = ({
    searchQuery,
    setSearchQuery,
    setCurrentPage,
    categoryFilter,
    setCategoryFilter,
    categories,
    isLoadingCategories,
    statusFilter,
    setStatusFilter,
    sortBy,
    setSortBy,
    totalHits,
    processingTime
}: ProductSearchHeaderProps) => {
    const queryClient = useQueryClient()
    return (
        <>
            {/* Header Title & Subtitle */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
                <div>
                    <div className="flex items-center gap-4">
                        <Heading level="h1" className="text-ui-fg-base">
                            Products
                        </Heading>
                        <SyncStatusButton
                            entity="products"
                            onSyncComplete={() => queryClient.invalidateQueries({ queryKey: ["meili-products"] })}
                        />
                    </div>
                    <Text size="small" className="text-ui-fg-subtle mt-1">
                        Search by SKU, title, description, or handle
                    </Text>
                </div>

                {/* Category Quick Search */}
                <div className="w-[220px]">
                    <Select
                        value={categoryFilter}
                        onValueChange={(value) => {
                            setCategoryFilter(value);
                            setCurrentPage(0);
                        }}
                        disabled={isLoadingCategories}
                    >
                        <Select.Trigger>
                            <Select.Value placeholder="Select Category..." />
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="all">All Categories</Select.Item>
                            {categories?.map((c: any) => (
                                <Select.Item key={c.id} value={c.handle}>
                                    {c.name}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                </div>
            </div>

            {/* Search Bar & Filters */}
            <div className="px-6 py-4 border-b bg-ui-bg-subtle">
                <div className="flex items-center gap-3">
                    <div className="flex-1 relative">
                        <Input
                            type="search"
                            placeholder="Search products... (e.g., SKU-123, name, etc.)"
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                setCurrentPage(0);
                            }}
                            autoFocus
                            className="w-full"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-ui-fg-muted">
                            <MagnifyingGlass />
                        </div>
                    </div>

                    {/* Status Filter */}
                    <Select value={statusFilter} onValueChange={(value: "all" | "published") => {
                        setStatusFilter(value);
                        setCurrentPage(0);
                    }}>
                        <Select.Trigger className="w-[140px]">
                            <Select.Value placeholder="Status" />
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="published">Published</Select.Item>
                            <Select.Item value="all">All Statuses</Select.Item>
                        </Select.Content>
                    </Select>

                    {/* Sort Dropdown */}
                    <Select value={sortBy} onValueChange={(value) => {
                        setSortBy(value);
                        setCurrentPage(0);
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

                    {totalHits !== undefined && (
                        <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
                            {totalHits} results ({processingTime}ms)
                        </Text>
                    )}
                </div>
            </div>
        </>
    );
};
