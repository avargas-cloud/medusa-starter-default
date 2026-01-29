import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container } from "@medusajs/ui"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Link } from "react-router-dom"
import { ChevronRightMini } from "@medusajs/icons"

/**
 * Product Breadcrumb Display Widget
 * 
 * Displays pre-calculated category breadcrumbs from product.metadata.
 * No API calls needed - breadcrumbs are auto-calculated when primary_category_id is saved.
 * 
 * Positioned at the very top of product detail pages via "product.details.before" zone.
 */
const ProductBreadcrumbWidget = ({ data: product }: DetailWidgetProps<AdminProduct>) => {
    const breadcrumbs = (product.metadata?.main_category_breadcrumbs as Array<{
        id: string
        name: string
        handle: string
    }>) || []

    // Don't render if no breadcrumbs
    if (breadcrumbs.length === 0) return null

    return (
        <Container className="px-6 py-3 bg-ui-bg-subtle border-b border-ui-border-base">
            <nav aria-label="Product Category Breadcrumb">
                <ol className="flex items-center gap-2 text-sm text-ui-fg-subtle">
                    {breadcrumbs.map((crumb, idx) => (
                        <li key={crumb.id} className="flex items-center gap-2">
                            {idx > 0 && <ChevronRightMini className="text-ui-fg-muted" />}
                            <Link
                                to={`/app/categories/${crumb.id}`}
                                className="hover:text-ui-fg-base transition-colors"
                            >
                                {crumb.name}
                            </Link>
                        </li>
                    ))}
                    <li className="flex items-center gap-2">
                        <ChevronRightMini className="text-ui-fg-muted" />
                        <span className="text-ui-fg-base font-medium truncate max-w-md">
                            {product.title}
                        </span>
                    </li>
                </ol>
            </nav>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.before",
})

export default ProductBreadcrumbWidget
