
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Container, Heading, Table, Badge, Text, Button } from "@medusajs/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ManageAttributesModal } from "../components/manage-attributes-modal"
import { sdk } from "../../lib/sdk"



// Helper to group flat attributes by Key
const groupAttributesByKey = (flatAttributes: any[], variantKeys: string[] = []) => {
    const groups: Record<string, any> = {};

    flatAttributes.forEach(attr => {
        const keyId = attr.attribute_key.id;

        if (!groups[keyId]) {
            groups[keyId] = {
                key_id: keyId,
                key_title: attr.attribute_key.label || attr.attribute_key.title,
                handle: attr.attribute_key.handle,
                is_variant: variantKeys.includes(keyId),
                values: []
            };
        }
        groups[keyId].values.push({
            id: attr.id,
            value: attr.value
        });
    });

    return Object.values(groups);
};

const ProductAttributesWidget = ({ data: initialProduct }: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()

    // 1. Fetch Attributes using Custom API (Robust)
    const { data: customData, isLoading, refetch } = useQuery({
        queryFn: async () => {
            return sdk.client.fetch<any>(`/admin/products/${initialProduct.id}/attributes`)
        },
        queryKey: [["product", initialProduct.id, "custom-attributes"]],
        retry: false
    })

    // Cast response to avoid TS error
    const attributes = (customData as any)?.attributes || []


    // 2. Fetch Product Metadata to know which keys are Variants
    // We can rely on initialProduct, but a fresh fetch is safer for "Atomic" truth
    const { data: productData, refetch: refetchProduct } = useQuery({
        queryFn: async () => {
            return sdk.admin.product.retrieve(initialProduct.id)
        },
        queryKey: [["product", initialProduct.id, "fresh-metadata"]]
    })

    const variantKeys = (productData?.product?.metadata?.variant_attributes as string[]) || []

    const [isManageModalOpen, setIsManageModalOpen] = useState(false)

    // Calculate Groups for Display & Sort (Variants first, then alphabetical)
    const groupedAttributes = groupAttributesByKey(attributes, variantKeys)
        .sort((a, b) => {
            // First: Sort by variant status (variants first)
            if (a.is_variant && !b.is_variant) return -1
            if (!a.is_variant && b.is_variant) return 1

            // Then: Sort alphabetically by key_title
            return a.key_title.localeCompare(b.key_title)
        })

    const handleSave = async (selectedAttributes: any[], variantFlags: Record<string, boolean>) => {
        // 1. Flatten selected values (Links)
        const valueIds = selectedAttributes.map(a => a.id)

        // 2. Collect Variant Keys
        // We only care about keys that are present in the selection AND flagged true
        const activeVariantKeys = Object.keys(variantFlags).filter(keyId => variantFlags[keyId])

        try {
            // Atomic POST
            await sdk.client.fetch(`/admin/products/${initialProduct.id}/attributes`, {
                method: "POST",
                body: {
                    value_ids: valueIds,
                    variant_keys: activeVariantKeys
                }
            })

            // COMPREHENSIVE INVALIDATION: Refresh ALL related widgets
            console.log("🔄 Invalidating all product-related queries...")

            // 1. Main product query
            await queryClient.invalidateQueries({
                queryKey: ['product', initialProduct.id]
            })

            // 2. Product with relations (includes options, variants)
            await queryClient.invalidateQueries({
                queryKey: ['products', initialProduct.id]
            })

            // 3. Custom attributes query
            await queryClient.invalidateQueries({
                queryKey: ['product', initialProduct.id, 'custom-attributes']
            })

            // 4. Product options (for Options widget)
            await queryClient.invalidateQueries({
                queryKey: ['product_options']
            })

            // 5. Product variants (for Variants widget)
            await queryClient.invalidateQueries({
                queryKey: ['product_variants']
            })

            // 6. Invalidate all queries for this product ID
            await queryClient.invalidateQueries({
                predicate: (query) => {
                    const key = query.queryKey
                    return Array.isArray(key) && key.includes(initialProduct.id)
                }
            })

            console.log("✅ All queries invalidated")

            // 7. FORCE REFETCH to apply sorting with fresh data
            console.log("🔄 Force refetching attributes AND product metadata...")
            await Promise.all([
                refetch(),           // Refetch attributes
                refetchProduct()     // Refetch product metadata (for variant_keys)
            ])

            console.log("✅ UI fully refreshed with sorted attributes and variant badges")

            setIsManageModalOpen(false)

        } catch (e) {
            console.error("Save Failed:", e)
            // Don't close modal on error
            throw e // Re-throw to show error in modal
        }
    }


    if (isLoading) {
        return <Container className="p-8">Loading attributes...</Container>
    }

    return (
        <Container className="p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">Product Attributes</Heading>
                <Button variant="secondary" onClick={() => setIsManageModalOpen(true)}>
                    Edit Attributes
                </Button>
            </div>

            <Table>
                <Table.Header>
                    <Table.Row>
                        <Table.HeaderCell>Attribute</Table.HeaderCell>
                        <Table.HeaderCell>Values</Table.HeaderCell>
                        <Table.HeaderCell>Variant?</Table.HeaderCell>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {groupedAttributes.length === 0 ? (
                        <Table.Row>
                            {/* @ts-expect-error colSpan valid in DOM but missing in Table.Cell types */}
                            <Table.Cell colSpan={3} className="text-ui-fg-subtle">
                                No attributes linked.
                            </Table.Cell>
                        </Table.Row>
                    ) : (
                        groupedAttributes.map((group: any) => (
                            <Table.Row key={group.key_id}>
                                <Table.Cell>
                                    <Text weight="plus">{group.key_title}</Text>
                                    <Text size="small" className="text-ui-fg-muted">{group.handle}</Text>
                                </Table.Cell>
                                <Table.Cell>
                                    <div className="flex gap-2 flex-wrap">
                                        {group.values.map((val: any) => (
                                            <Badge key={val.id}>{val.value}</Badge>
                                        ))}
                                    </div>
                                </Table.Cell>
                                <Table.Cell>
                                    {group.is_variant ? (
                                        <Badge color="purple">Variant</Badge>
                                    ) : (
                                        <Text size="small" className="text-ui-fg-muted">-</Text>
                                    )}
                                </Table.Cell>
                            </Table.Row>
                        ))
                    )}
                </Table.Body>
            </Table>

            {isManageModalOpen && (
                <ManageAttributesModal
                    open={isManageModalOpen}
                    onOpenChange={setIsManageModalOpen}
                    currentAttributes={attributes}
                    initialVariantKeys={variantKeys}
                    onSaveAtomic={handleSave}
                />
            )}
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.after",
})

export default ProductAttributesWidget
