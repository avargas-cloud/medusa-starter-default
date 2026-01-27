import { Button, Text } from "@medusajs/ui"
import { ArrowLeftMini, ArrowRightMini } from "@medusajs/icons"

interface InventoryPaginationProps {
    currentPage: number
    totalPages: number
    onPageChange: (page: number) => void
    totalItems: number
    itemsPerPage: number
}

/**
 * Component: Inventory Pagination
 * 
 * Pagination controls for inventory table
 */
export const InventoryPagination = ({
    currentPage,
    totalPages,
    onPageChange,
    totalItems,
    itemsPerPage,
}: InventoryPaginationProps) => {
    const startItem = currentPage * itemsPerPage + 1
    const endItem = Math.min((currentPage + 1) * itemsPerPage, totalItems)

    return (
        <div className="flex items-center justify-between px-6 py-4 border-t">
            <Text size="small" className="text-ui-fg-subtle">
                Showing {startItem} to {endItem} of {totalItems} items
            </Text>

            <div className="flex items-center gap-2">
                <Button
                    variant="secondary"
                    size="small"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 0}
                >
                    <ArrowLeftMini />
                    Previous
                </Button>

                <Text size="small" className="text-ui-fg-subtle px-4">
                    Page {currentPage + 1} of {totalPages}
                </Text>

                <Button
                    variant="secondary"
                    size="small"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages - 1}
                >
                    Next
                    <ArrowRightMini />
                </Button>
            </div>
        </div>
    )
}
