import { Container, Toaster, Table } from "@medusajs/ui";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import "../../styles/scrollbar-fix.css";

// Logic
import { useCustomerPageState } from "./hooks/use-customer-page-state";

// Components
import { CustomerHeader } from "./components/customer-header";
import { CustomerTable } from "./components/customer-table";

/**
 * Customers Advanced Search Page
 */
const CustomerSearchPage = () => {
    const queryClient = useQueryClient();
    const {
        headerProps,
        tableProps,
        paginationProps
    } = useCustomerPageState();

    // Invalidate cache when mounting to ensure fresh data after edits
    useEffect(() => {
        queryClient.invalidateQueries({ queryKey: ["meili-customers"] });
    }, [queryClient]);

    return (
        <>
            <Toaster />
            <Container className="divide-y p-0 h-full flex flex-col overflow-hidden">
                <CustomerHeader {...headerProps} />
                <CustomerTable {...tableProps} />

                {/* Pagination */}
                <div className="flex items-center justify-between px-6 py-4 border-t">
                    <p className="text-small text-ui-fg-subtle">
                        Showing {Math.min((paginationProps.currentPage + 1) * paginationProps.itemsPerPage, paginationProps.totalHits)} of {paginationProps.totalHits} results
                    </p>
                    <div className="flex items-center gap-x-2">
                        <Table.Pagination
                            count={paginationProps.totalHits}
                            pageSize={paginationProps.itemsPerPage}
                            pageIndex={paginationProps.currentPage}
                            pageCount={paginationProps.totalPages}
                            canPreviousPage={paginationProps.canGoPrevious}
                            canNextPage={paginationProps.canGoNext}
                            previousPage={paginationProps.onPrevious}
                            nextPage={paginationProps.onNext}
                        />
                    </div>
                </div>
            </Container>
        </>
    );
};

export default CustomerSearchPage;
