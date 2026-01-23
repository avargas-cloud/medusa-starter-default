import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Select, Button, toast, Text } from "@medusajs/ui"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { useState, useEffect } from "react"
import { BASE_URL } from "../../lib/sdk"

const PrimaryCategoryWidget = ({ data: productData }: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()
    const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined)

    // Fetch product with categories
    const { data: response, isLoading } = useQuery({
        queryFn: async () => {
            const res = await fetch(
                `${BASE_URL}/admin/products/${productData.id}?fields=+categories.id,+categories.name,+metadata`,
                {
                    credentials: "include",
                }
            )
            if (!res.ok) throw new Error("Failed to fetch product")
            return res.json()
        },
        queryKey: ["product", productData.id, "primary-category-sync"],
    })

    const product = response?.product
    const associatedCategories = product?.categories || []

    // Sync state with metadata
    useEffect(() => {
        if (product?.metadata?.primary_category_id) {
            setSelectedCategory(product.metadata.primary_category_id as string)
        }
    }, [product])

    // Update mutation
    const updateProduct = useMutation({
        mutationFn: async (categoryId: string) => {
            const res = await fetch(`${BASE_URL}/admin/products/${productData.id}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...product?.metadata,
                        primary_category_id: categoryId,
                    },
                })
            })
            if (!res.ok) throw new Error("Failed to update primary category")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Primary category updated successfully")
            queryClient.invalidateQueries({ queryKey: ["product", productData.id] })
        },
        onError: (err) => {
            toast.error("Failed to update", {
                description: (err as Error).message
            })
        }
    })

    const handleSave = () => {
        if (selectedCategory) {
            updateProduct.mutate(selectedCategory)
        }
    }

    if (isLoading || !product) {
        return (
            <Container>
                <div className="px-6 py-4">
                    <Text size="small" className="text-ui-fg-subtle">Loading...</Text>
                </div>
            </Container>
        )
    }

    return (
        <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">Primary Category</Heading>
            </div>

            <div className="px-6 py-4">
                {associatedCategories.length === 0 ? (
                    <Text size="small" className="text-ui-fg-subtle">
                        This product has no categories assigned. Add categories in the Organization widget above.
                    </Text>
                ) : (
                    <div className="flex flex-col gap-4">
                        <Select
                            value={selectedCategory}
                            onValueChange={setSelectedCategory}
                        >
                            <Select.Trigger>
                                <Select.Value placeholder="Select primary category" />
                            </Select.Trigger>
                            <Select.Content>
                                {associatedCategories.map((cat: { id: string; name: string }) => (
                                    <Select.Item key={cat.id} value={cat.id}>
                                        {cat.name}
                                    </Select.Item>
                                ))}
                            </Select.Content>
                        </Select>

                        <Button
                            size="small"
                            variant="secondary"
                            onClick={handleSave}
                            isLoading={updateProduct.isPending}
                            disabled={!selectedCategory || selectedCategory === product.metadata?.primary_category_id}
                        >
                            Save Selection
                        </Button>
                    </div>
                )}
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.side.after",
})

export default PrimaryCategoryWidget
