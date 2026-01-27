import { Heading, Text, Input, Select } from "@medusajs/ui"
import { MagnifyingGlass } from "@medusajs/icons"

interface InventoryHeaderProps {
    searchQuery: string
    onSearchChange: (value: string) => void
    onRefresh: () => void
    categoryFilter: string
    onCategoryChange: (category: string) => void
    categories: any[]
    isLoadingCategories: boolean
    sortBy: string
    onSortChange: (sort: string) => void
    totalItems: number
}

/**
 * Component: Inventory Header
 * 
 * Header with category filter, search, and sort options
 * Replicates ProductSearchHeader design
 */
export const InventoryHeader = ({
    searchQuery,
    onSearchChange,
    categoryFilter,
    onCategoryChange,
    categories,
    isLoadingCategories,
    sortBy,
    onSortChange,
    totalItems,
}: InventoryHeaderProps) => {
    return (
        <>
            {/* Header Title & Category Filter */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
                <div>
                    <Heading level="h1" className="text-ui-fg-base">
                        Inventory
                    </Heading>
                    <Text size="small" className="text-ui-fg-subtle mt-1">
                        Manage your inventory items with prices
                    </Text>
                </div>

                {/* Category Quick Filter */}
                <div className="w-[220px]">
                    <Select
                        value={categoryFilter}
                        onValueChange={onCategoryChange}
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
                            placeholder="Search by SKU or title..."
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            autoFocus
                            className="w-full"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-ui-fg-muted">
                            <MagnifyingGlass />
                        </div>
                    </div>

                    {/* Sort Dropdown */}
                    <Select value={sortBy} onValueChange={onSortChange}>
                        <Select.Trigger className="w-[180px]">
                            <Select.Value placeholder="Sort by..." />
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="title:asc">Title A-Z</Select.Item>
                            <Select.Item value="title:desc">Title Z-A</Select.Item>
                            <Select.Item value="stock:asc">Stock: Low First</Select.Item>
                            <Select.Item value="stock:desc">Stock: High First</Select.Item>
                            <Select.Item value="sku:asc">SKU A-Z</Select.Item>
                            <Select.Item value="sku:desc">SKU Z-A</Select.Item>
                        </Select.Content>
                    </Select>

                    {totalItems !== undefined && (
                        <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
                            {totalItems} items
                        </Text>
                    )}
                </div>
            </div>
        </>
    )
}
