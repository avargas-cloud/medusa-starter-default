
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Accordion, Text, Button, Badge, StatusBadge } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useParams, Link } from "react-router-dom"
import { PencilSquare } from "@medusajs/icons"

// Type Definition matching our API
type AttributeValue = {
    id: string
    value: string
    attribute_key: {
        id: string
        label: string
        handle: string
        attribute_set?: {
            id: string
            title: string
        }
    }
}

type AttributeResponse = {
    attributes: AttributeValue[]
}

const ProductAttributesWidget = () => {
    const { id } = useParams()

    const { data, isLoading, isError } = useQuery<AttributeResponse>({
        queryKey: ["product-attributes", id],
        queryFn: async () => {
            const res = await fetch(`http://localhost:9000/admin/products/${id}/attributes`)
            if (!res.ok) throw new Error("Failed to fetch attributes")
            return res.json()
        }
    })

    if (isLoading) {
        return (
            <Container className="p-8">
                <Text>Loading attributes...</Text>
            </Container>
        )
    }

    if (isError || !data) {
        return (
            <Container className="p-8">
                <Text className="text-ui-fg-error">Error loading attributes.</Text>
            </Container>
        )
    }

    const attributes = data.attributes

    // Grouping Logic
    const groups: Record<string, { title: string, items: AttributeValue[] }> = {}
    const unsorted: AttributeValue[] = []

    attributes.forEach(attr => {
        const set = attr.attribute_key?.attribute_set
        if (set) {
            if (!groups[set.id]) {
                groups[set.id] = { title: set.title, items: [] }
            }
            groups[set.id].items.push(attr)
        } else {
            unsorted.push(attr)
        }
    })

    // Sort Groups (Optional: Alphabetical)
    const sortedGroupKeys = Object.keys(groups).sort((a, b) =>
        groups[a].title.localeCompare(groups[b].title)
    )

    // Helper to render a list of attributes
    const AttributeList = ({ items }: { items: AttributeValue[] }) => (
        <div className="flex flex-col gap-2 py-2">
            {items.map(attr => (
                <div
                    key={attr.id}
                    className="flex items-center justify-between p-3 rounded-md hover:bg-ui-bg-base-hover transition-colors border border-transparent hover:border-ui-border-base cursor-pointer group"
                // On click logic could go here, or link wrapping
                >
                    <div className="flex flex-col">
                        <Text className="txt-small text-ui-fg-subtle">{attr.attribute_key.label}</Text>
                        <Text className="txt-medium font-medium text-ui-fg-base">{attr.value}</Text>
                    </div>
                    {/* Visual hint for interaction */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <PencilSquare className="text-ui-fg-muted" />
                    </div>
                </div>
            ))}
        </div>
    )

    return (
        <Container className="p-0 overflow-hidden">
            <div className="p-6 border-b border-ui-border-base flex justify-between items-center bg-ui-bg-subtle">
                <div className="flex flex-col gap-1">
                    <Heading level="h2">Product Attributes</Heading>
                    <Text className="text-ui-fg-subtle">
                        {attributes.length} attributes assigned to this product.
                    </Text>
                </div>
                <Button variant="secondary" size="small">
                    Edit Attributes
                </Button>
            </div>

            <div className="p-0">
                <Accordion type="multiple" defaultValue={["unsorted"]}>
                    {/* Unsorted Group (Always First) */}
                    {unsorted.length > 0 && (
                        <Accordion.Item value="unsorted" className="border-b border-ui-border-base">
                            <Accordion.Trigger className="px-6 py-4 hover:bg-ui-bg-subtle">
                                <div className="flex items-center gap-2">
                                    <Text className="font-medium">Unsorted / General</Text>
                                    <Badge size="small" color="grey">{unsorted.length}</Badge>
                                </div>
                            </Accordion.Trigger>
                            <Accordion.Content className="px-6 pb-4">
                                <AttributeList items={unsorted} />
                            </Accordion.Content>
                        </Accordion.Item>
                    )}

                    {/* Attribute Sets */}
                    {sortedGroupKeys.map(groupId => {
                        const group = groups[groupId]
                        return (
                            <Accordion.Item key={groupId} value={groupId} className="border-b border-ui-border-base last:border-b-0">
                                <Accordion.Trigger className="px-6 py-4 hover:bg-ui-bg-subtle">
                                    <div className="flex items-center gap-2">
                                        <Text className="font-medium">{group.title}</Text>
                                        <Badge size="small" color="blue">{group.items.length}</Badge>
                                    </div>
                                </Accordion.Trigger>
                                <Accordion.Content className="px-6 pb-4">
                                    <AttributeList items={group.items} />
                                </Accordion.Content>
                            </Accordion.Item>
                        )
                    })}

                    {attributes.length === 0 && (
                        <div className="p-8 flex flex-col items-center justify-center text-center">
                            <Text className="text-ui-fg-subtle">No attributes found.</Text>
                            <Text className="txt-small text-ui-fg-muted mt-2">
                                Run the migration or add attributes manually.
                            </Text>
                        </div>
                    )}
                </Accordion>
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.after",
})

export default ProductAttributesWidget
