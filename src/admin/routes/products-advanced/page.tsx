import { Container, Toaster } from "@medusajs/ui";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import "../../styles/scrollbar-fix.css";

// Logic
import { useProductPageState } from "./hooks/use-product-page-state";

// Components
import { ProductSearchHeader } from "./components/product-search-header";
import { ProductTable } from "./components/product-table";
import { ProductPagination } from "./components/product-pagination";

/**
 * Advanced Product Search Page
 * 
 * Clean orchestration component. 
 * Delegates logic to `useProductPageState` and rendering to dumb components.
 */
const ProductSearchPage = () => {
    const queryClient = useQueryClient();
    const { headerProps, tableProps, paginationProps } = useProductPageState();

    // Invalidate cache when mounting to ensure fresh data after edits
    useEffect(() => {
        queryClient.invalidateQueries({ queryKey: ["meili-products"] });
    }, [queryClient]);

    return (
        <>
            <Toaster />
            <Container className="divide-y p-0 h-full flex flex-col overflow-hidden">
                <ProductSearchHeader {...headerProps} />
                <ProductTable {...tableProps} />
                <ProductPagination {...paginationProps} />
            </Container>
        </>
    );
};

export default ProductSearchPage;
