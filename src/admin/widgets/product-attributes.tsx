import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Badge, Button } from "@medusajs/ui"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { PencilSquare } from "@medusajs/icons"
import { ManageAttributesModal } from "../components/manage-attributes-modal"

const ProductAttributesWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
    const productId = data?.id
    const [open, setOpen] = useState(false)

    const { data: linkedAttrs } = useQuery({
        queryKey: ["product-attributes", productId],
        queryFn: async () => {
            const res = await fetch(`/admin/products/${productId}/attributes`, {
                credentials: "include",
            })
            if (!res.ok) return { attributes: [] }
            return res.json()
        },
        enabled: !!productId,
    })

    const attributes = Array.isArray(linkedAttrs?.attributes) ? linkedAttrs.attributes : []

    return (
        <Container>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Heading level="h2">Product Attributes</Heading>
                    <Badge size="small" color="grey">
                        {attributes.length} assigned
                    </Badge>
                </div>
                <Button variant="secondary" onClick={() => setOpen(true)}>
                    <PencilSquare /> Edit
                </Button>
            </div>

            {attributes.length === 0 ? (
                <p className="text-ui-fg-subtle text-sm">
                    No attributes assigned to this product yet.
                </p>
            ) : (
                <div className="grid gap-2">
                    {attributes.map((attr: any) => (
                        <div
                            key={attr.id}
                            className="bg-ui-bg-subtle p-3 rounded border border-ui-border-base"
                        >
                            <p className="text-ui-fg-base font-medium text-sm">{attr.attribute_key?.label || "Unknown"}</p>
                            <p className="text-ui-fg-muted text-xs">
                                <span className="text-ui-fg-subtle">{attr.value}</span>
                            </p>
                        </div>
                    ))}
                </div>
            )}

            <ManageAttributesModal
                open={open}
                onOpenChange={setOpen}
                productId={productId}
                currentAttributes={attributes}
            />
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.after",
})

export default ProductAttributesWidget
