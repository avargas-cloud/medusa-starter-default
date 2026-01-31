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
            <Container className="divide-y p-0">
                <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex gap-x-4 items-center">
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-ui-bg-base border border-ui-border-base">
                            <ListTree className="text-ui-fg-subtle" />
                        </div>
                        <div>
                            <Heading level="h2">Subcategory Sorting</Heading>
                            <Text className="text-ui-fg-subtle text-sm">
                                Manage the display order of subcategories
                            </Text>
                        </div>
                    </div>
                    <Button variant="secondary" size="small" onClick={() => setIsModalOpen(true)}>
                        Manage Subcategory Sorting
                    </Button>
                </div>
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
