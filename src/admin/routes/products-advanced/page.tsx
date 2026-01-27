import { Container, Toaster } from "@medusajs/ui";
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
    const { headerProps, tableProps, paginationProps } = useProductPageState();

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
