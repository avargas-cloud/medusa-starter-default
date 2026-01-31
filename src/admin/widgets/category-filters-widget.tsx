import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Badge, Text, Button } from "@medusajs/ui"
import { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { useEffect, useState } from "react"
import { PencilSquare } from "@medusajs/icons"
import { ManageFiltersModal } from "../components/manage-filters-modal"
import { toast } from "@medusajs/ui"

type CategoryWithMetadata = AdminProductCategory & {
    metadata?: {
        filter_config?: {
            active_filters: string[] | Array<{ attribute_id: string; order: number }>
            override_inheritance?: boolean
        }
        available_attributes?: string[]
    }
}

type Attribute = {
    id: string
    label: string
    handle: string
    filter_type: string
}

const CategoryFiltersWidget = ({ data }: DetailWidgetProps<CategoryWithMetadata>) => {
    const [attributes, setAttributes] = useState<Attribute[]>([])
    const [loading, setLoading] = useState(true)
    const [isModalOpen, setIsModalOpen] = useState(false)

    useEffect(() => {
        const fetchAttributes = async () => {
            try {
                const response = await fetch("/admin/attributes", {
                    credentials: "include"
                })
                const result = await response.json()
                console.log("[WIDGET] API Response:", result)
                setAttributes(result.attribute_keys || [])
            } catch (error) {
                console.error("[WIDGET] Failed to fetch attributes:", error)
            } finally {
                setLoading(false)
            }
        }

        fetchAttributes()
    }, [])

    if (loading) {
        return (
            <Container className="divide-y p-0">
                <div className="flex items-center justify-between px-6 py-4">
                    <Heading level="h2">Category Filters</Heading>
                </div>
                <div className="px-6 py-4 text-ui-fg-subtle">
                    Loading...
                </div>
            </Container>
        )
    }

    const filterConfig = data.metadata?.filter_config
    const availableAttributeIds = data.metadata?.available_attributes || []

    // Parse active filter IDs
    let activeFilterIds: string[] = []
    if (filterConfig?.active_filters) {
        const first = filterConfig.active_filters[0]
        if (typeof first === "string") {
            activeFilterIds = filterConfig.active_filters as string[]
        } else if (typeof first === "object" && (first as any).attribute_id) {
            activeFilterIds = (filterConfig.active_filters as Array<{ attribute_id: string }>).map(f => f.attribute_id)
        }
    }

    const overrideInheritance = filterConfig?.override_inheritance ?? false

    // Filter attributes
    console.log("[WIDGET] All attributes:", attributes.length, attributes.map(a => ({ id: a.id, label: a.label })))
    console.log("[WIDGET] Active filter IDs:", activeFilterIds)
    console.log("[WIDGET] Available attribute IDs:", availableAttributeIds)

    const activeAttrs = attributes.filter(attr => activeFilterIds.includes(attr.id))
    console.log("[WIDGET] Active attrs found:", activeAttrs.length, activeAttrs.map(a => a.label))

    const availableAttrs = attributes.filter(attr => availableAttributeIds.includes(attr.id))
    console.log("[WIDGET] Available attrs found:", availableAttrs.length)

    const inactiveAttrs = attributes.filter(attr => !activeFilterIds.includes(attr.id))
    console.log("[WIDGET] Inactive attrs found:", inactiveAttrs.length)

    const hasFilters = activeFilterIds.length > 0 || availableAttributeIds.length > 0

    const handleSave = async (newActiveIds: string[], newOverride: boolean) => {
        try {
            const response = await fetch(`/admin/product-categories/${data.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...data.metadata,
                        filter_config: {
                            active_filters: newActiveIds,
                            override_inheritance: newOverride
                        }
                    }
                })
            })

            if (!response.ok) throw new Error("Failed to save")

            toast.success("Success", {
                description: "Category filters updated successfully"
            })

            // Refresh page to reload category data (required for widget update)
            window.location.reload()
        } catch (error) {
            toast.error("Error", {
                description: "Failed to save category filters"
            })
            throw error
        }
    }

    if (!hasFilters) {
        return (
            <>
                <Container className="divide-y p-0">
                    <div className="flex items-center justify-between px-6 py-4">
                        <Heading level="h2">Category Filters</Heading>
                        <Button size="small" variant="secondary" onClick={() => setIsModalOpen(true)}>
                            <PencilSquare /> Configure Filters
                        </Button>
                    </div>
                    <div className="px-6 py-4">
                        <Text className="text-ui-fg-subtle">
                            No filters configured for this category.
                        </Text>
                    </div>
                </Container>

                <ManageFiltersModal
                    open={isModalOpen}
                    onOpenChange={setIsModalOpen}
                    categoryId={data.id}
                    categoryName={data.name}
                    activeFilterIds={activeFilterIds}
                    availableAttributes={attributes}
                    overrideInheritance={overrideInheritance}
                    onSave={handleSave}
                />
            </>
        )
    }

    return (
        <>
            <Container className="divide-y p-0">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4">
                    <Heading level="h2">Category Filters</Heading>
                    <div className="flex gap-2">
                        {overrideInheritance && (
                            <Badge size="small" color="orange">Override Inheritance</Badge>
                        )}
                        <Button size="small" variant="secondary" onClick={() => setIsModalOpen(true)}>
                            <PencilSquare /> Edit
                        </Button>
                    </div>
                </div>

                {/* Active Filters */}
                {activeFilterIds.length > 0 && (
                    <div className="px-6 py-4">
                        <div className="flex items-center gap-2 mb-3">
                            <Text weight="plus" size="small">Active Filters</Text>
                            <Badge size="small" color="green">{activeFilterIds.length}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {activeAttrs.map(attr => (
                                <Badge key={attr.id} size="small" color="blue">
                                    {attr.label}
                                </Badge>
                            ))}
                        </div>
                    </div>
                )}

                {/* Inactive Filters */}
                {inactiveAttrs.length > 0 && (
                    <div className="px-6 py-4">
                        <div className="flex items-center gap-2 mb-3">
                            <Text weight="plus" size="small">Inactive Filters</Text>
                            <Badge size="small" color="grey">{inactiveAttrs.length}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {inactiveAttrs.map(attr => (
                                <Badge key={attr.id} size="small" color="grey">
                                    {attr.label}
                                </Badge>
                            ))}
                        </div>
                        <Text className="text-ui-fg-muted text-xs mt-3">
                            Click "Edit" to activate these filters
                        </Text>
                    </div>
                )}
            </Container>

            <ManageFiltersModal
                open={isModalOpen}
                onOpenChange={setIsModalOpen}
                categoryId={data.id}
                categoryName={data.name}
                activeFilterIds={activeFilterIds}
                availableAttributes={attributes}
                overrideInheritance={overrideInheritance}
                onSave={handleSave}
            />
        </>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.after"
})

export default CategoryFiltersWidget
