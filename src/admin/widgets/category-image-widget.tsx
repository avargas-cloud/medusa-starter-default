import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading } from "@medusajs/ui"
import { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"

// Widget to display category image in sidebar
const CategoryImageWidget = ({
    data
}: DetailWidgetProps<AdminProductCategory>) => {
    if (!data?.thumbnail) {
        return <></> // Don't show widget if no image
    }

    return (
        <Container className="divide-y p-0">
            <div className="flex flex-col gap-4 px-6 py-4">
                <Heading level="h2">Category Image</Heading>
                <img
                    src={data.thumbnail}
                    alt={data.name}
                    className="w-full rounded-lg border border-gray-200"
                />
            </div>
        </Container>
    )
}

// Widget configuration
export const config = defineWidgetConfig({
    zone: "product_category.details.side.after",
})

export default CategoryImageWidget
