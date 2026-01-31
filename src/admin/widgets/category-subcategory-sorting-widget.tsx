import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { ListTree } from "@medusajs/icons"
import { useState } from "react"
import { ManageSubcategorySortingModal } from "../components/manage-subcategory-sorting-modal"

type CategoryData = {
    id: string
    name: string
}

const CategorySubcategorySortingWidget = ({ data }: DetailWidgetProps<CategoryData>) => {
    const [isModalOpen, setIsModalOpen] = useState(false)

    return (
        <>
            <Container className="p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-ui-bg-base-hover rounded-md">
                        <ListTree className="text-ui-fg-subtle" />
                    </div>
                    <div>
                        <Heading level="h2" className="text-ui-fg-base text-sm font-medium">
                            Subcategory Sorting
                        </Heading>
                        <Text className="text-ui-fg-subtle text-xs">
                            Customize the display order of subcategories in this category.
                        </Text>
                    </div>
                </div>
                <Button variant="secondary" size="small" onClick={() => setIsModalOpen(true)}>
                    Manage Subcategory Sorting
                </Button>
            </Container>

            <ManageSubcategorySortingModal
                open={isModalOpen}
                onOpenChange={setIsModalOpen}
                categoryId={data.id}
                categoryName={data.name}
            />
        </>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.after",
})

export default CategorySubcategorySortingWidget
