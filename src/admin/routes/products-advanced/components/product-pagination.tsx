import { Button, Text } from "@medusajs/ui";

interface ProductPaginationProps {
    currentPage: number;
    totalPages: number;
    totalHits: number;
    canGoPrevious: boolean;
    canGoNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
    itemsPerPage: number;
}

export const ProductPagination = ({
    currentPage,
    totalPages,
    totalHits,
    canGoPrevious,
    canGoNext,
    onPrevious,
    onNext,
    itemsPerPage
}: ProductPaginationProps) => {
    if (!totalHits || totalHits <= itemsPerPage) return null;

    return (
        <div className="flex items-center justify-between px-6 py-4 border-t">
            <Text size="small" className="text-ui-fg-subtle">
                Page {currentPage + 1} of {totalPages} ({totalHits} total products)
            </Text>
            <div className="flex gap-2">
                <Button
                    variant="secondary"
                    size="small"
                    onClick={onPrevious}
                    disabled={!canGoPrevious}
                >
                    Previous
                </Button>
                <Button
                    variant="secondary"
                    size="small"
                    onClick={onNext}
                    disabled={!canGoNext}
                >
                    Next
                </Button>
            </div>
        </div>
    );
};
