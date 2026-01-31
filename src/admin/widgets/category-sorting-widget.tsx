import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Button, Text } from "@medusajs/ui"
import { ListTree } from "@medusajs/icons"
import { Link } from "react-router-dom"

interface CategorySortingWidgetProps {
    data: {
        id: string
        name: string
    }
}

/**
 * Widget that appears on the Category Details page (Admin).
 * Provides a direct link to the Sorting interface for this category.
 */
const CategorySortingWidget = ({ data }: CategorySortingWidgetProps) => {
    return (
        <Container className="p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
                <div className="p-2 bg-ui-bg-base-hover rounded-md">
                    <ListTree className="text-ui-fg-subtle" />
                </div>
                <div>
                    <Heading level="h2" className="text-ui-fg-base text-sm font-medium">
                        Product Sorting
                    </Heading>
                    <Text className="text-ui-fg-subtle text-xs">
                        Customize the display order of products in this category.
                    </Text>
                </div>
            </div>

            <Link to={`/app/sorting?category_id=${data.id}`}>
                <Button variant="secondary" size="small">
                    Manage Product Sorting
                </Button>
            </Link>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.after",
})

export default CategorySortingWidget
