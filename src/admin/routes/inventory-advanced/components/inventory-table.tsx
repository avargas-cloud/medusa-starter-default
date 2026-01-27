import { Table, Badge, DropdownMenu, IconButton, clx } from "@medusajs/ui"
import { EllipsisHorizontal, PencilSquare, Trash, TagSolid, TriangleUpMini, TriangleDownMini } from "@medusajs/icons"
import { MeiliInventoryItem } from "../../../lib/meili-types"
import { useNavigate } from "react-router-dom"

interface InventoryTableProps {
    items: MeiliInventoryItem[]
    isLoading: boolean
    sortBy?: string
    onSortChange?: (sort: string) => void
}

/**
 * Component: Inventory Table
 * 
 * NOW POWERED BY MEILISEARCH
 * Main table with columns: Title, SKU, Reserved, In Stock, Price, Actions
 * Clickable cells for navigation:
 * - Title, SKU, Reserved, Stock → Inventory Item page
 * - Price → Variant Edit page
 */
export const InventoryTable = ({ items, isLoading, sortBy, onSortChange }: InventoryTableProps) => {
    const navigate = useNavigate()

    const formatPrice = (price: number, currencyCode: string) => {
        return `${currencyCode} $${price.toFixed(2)}`
    }

    // Navigate to Inventory Item page
    const goToInventoryItem = (id: string) => {
        navigate(`/inventory/${id}`)
    }

    // Navigate to Variant Edit page
    const goToVariantEdit = (productId: string | null, variantId: string | null) => {
        if (!productId || !variantId) {
            console.warn("Missing productId or variantId for navigation")
            return
        }
        navigate(`/products/${productId}/variants/${variantId}`)
    }

    const handleHeaderClick = (column: string) => {
        if (!onSortChange) return

        // If currently sorting by this column, toggle direction
        if (sortBy?.startsWith(column)) {
            const direction = sortBy.endsWith('asc') ? 'desc' : 'asc'
            onSortChange(`${column}:${direction}`)
        } else {
            // Default to ascending for new column
            onSortChange(`${column}:asc`)
        }
    }

    const SortIndicator = ({ column }: { column: string }) => {
        if (!sortBy?.startsWith(column)) return <div className="w-4 h-4 ml-1" /> // Placeholder to prevent jump

        return sortBy.endsWith('asc')
            ? <TriangleUpMini className="w-4 h-4 ml-1 text-ui-fg-interactive" />
            : <TriangleDownMini className="w-4 h-4 ml-1 text-ui-fg-interactive" />
    }

    const HeaderCell = ({ column, children, className }: { column: string, children: React.ReactNode, className?: string }) => (
        <Table.HeaderCell
            className={clx("cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors select-none", className)}
            onClick={() => handleHeaderClick(column)}
        >
            <div className="flex items-center">
                {children}
                <SortIndicator column={column} />
            </div>
        </Table.HeaderCell>
    )

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-ui-fg-subtle">Loading...</div>
            </div>
        )
    }

    return (
        <div className="flex-1 overflow-auto">
            <Table>
                <Table.Header>
                    <Table.Row>
                        <Table.HeaderCell className="w-16">Image</Table.HeaderCell>
                        <HeaderCell column="title">Title</HeaderCell>
                        <HeaderCell column="sku">SKU</HeaderCell>
                        <Table.HeaderCell>Reserved</Table.HeaderCell>
                        <HeaderCell column="totalStock">In Stock</HeaderCell>
                        <HeaderCell column="price">Price</HeaderCell>
                        <Table.HeaderCell className="w-12"></Table.HeaderCell>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {items.length === 0 ? (
                        <Table.Row>
                            <Table.Cell className="text-center text-ui-fg-subtle py-8">
                                No inventory items found
                            </Table.Cell>
                            <Table.Cell />
                            <Table.Cell />
                            <Table.Cell />
                            <Table.Cell />
                            <Table.Cell />
                            <Table.Cell />
                        </Table.Row>
                    ) : (
                        items.map((item) => (
                            <Table.Row key={item.id}>
                                {/* Thumbnail */}
                                <Table.Cell>
                                    <div className="h-10 w-10 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
                                        {item.thumbnail ? (
                                            <img
                                                src={item.thumbnail}
                                                alt={item.title}
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            <TagSolid className="text-ui-fg-muted" />
                                        )}
                                    </div>
                                </Table.Cell>

                                {/* Title - Clickable → Inventory Item */}
                                <Table.Cell
                                    onClick={() => goToInventoryItem(item.id)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    <span className="font-medium text-ui-fg-base">
                                        {item.title}
                                    </span>
                                </Table.Cell>

                                {/* SKU - Clickable → Inventory Item */}
                                <Table.Cell
                                    onClick={() => goToInventoryItem(item.id)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    <span className="font-mono text-sm text-ui-fg-subtle">
                                        {item.sku}
                                    </span>
                                </Table.Cell>

                                {/* Reserved - Clickable → Inventory Item */}
                                <Table.Cell
                                    onClick={() => goToInventoryItem(item.id)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    {item.totalReserved > 0 ? (
                                        <span className="text-ui-fg-muted">
                                            {item.totalReserved}
                                        </span>
                                    ) : (
                                        <span className="text-ui-fg-disabled">0</span>
                                    )}
                                </Table.Cell>

                                {/* In Stock - Clickable → Inventory Item */}
                                <Table.Cell
                                    onClick={() => goToInventoryItem(item.id)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    {item.totalStock > 0 ? (
                                        <span className="text-ui-fg-base font-medium">
                                            {item.totalStock}
                                        </span>
                                    ) : (
                                        <Badge color="red" size="small">
                                            0
                                        </Badge>
                                    )}
                                </Table.Cell>

                                {/* Price - Clickable → Variant Edit */}
                                <Table.Cell
                                    onClick={() => goToVariantEdit(item.productId, item.variantId)}
                                    className="cursor-pointer hover:bg-ui-bg-subtle-hover transition-colors"
                                >
                                    <span className="font-medium text-ui-fg-base">
                                        {formatPrice(item.price, item.currencyCode)}
                                    </span>
                                </Table.Cell>

                                {/* Actions (3-dot menu) */}
                                <Table.Cell>
                                    <DropdownMenu>
                                        <DropdownMenu.Trigger asChild>
                                            <IconButton variant="transparent">
                                                <EllipsisHorizontal />
                                            </IconButton>
                                        </DropdownMenu.Trigger>
                                        <DropdownMenu.Content align="end">
                                            <DropdownMenu.Item
                                                onClick={() => goToInventoryItem(item.id)}
                                            >
                                                <PencilSquare className="mr-2" />
                                                Edit Inventory
                                            </DropdownMenu.Item>
                                            {item.variantId && item.productId && (
                                                <DropdownMenu.Item
                                                    onClick={() => goToVariantEdit(item.productId, item.variantId)}
                                                >
                                                    <PencilSquare className="mr-2" />
                                                    Edit Variant
                                                </DropdownMenu.Item>
                                            )}
                                            <DropdownMenu.Separator />
                                            <DropdownMenu.Item
                                                className="text-ui-fg-error"
                                                onClick={() => {
                                                    // Future: Delete action
                                                    // console.log("Delete:", item.id)
                                                }}
                                            >
                                                <Trash className="mr-2" />
                                                Delete
                                            </DropdownMenu.Item>
                                        </DropdownMenu.Content>
                                    </DropdownMenu>
                                </Table.Cell>
                            </Table.Row>
                        ))
                    )}
                </Table.Body>
            </Table>
        </div>
    )
}
