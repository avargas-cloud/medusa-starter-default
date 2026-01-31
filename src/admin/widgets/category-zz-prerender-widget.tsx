import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Switch, Label, Text } from "@medusajs/ui"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { useState, useEffect } from "react"

type CategoryWithMetadata = {
    id: string
    name: string
    metadata?: {
        prerender?: boolean
    }
}

const CategoryPrerenderWidget = ({ data }: DetailWidgetProps<CategoryWithMetadata>) => {
    const [prerender, setPrerender] = useState<boolean>(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    // CRITICAL: Fetch fresh metadata on mount (bypasses Admin UI cache)
    // Unlike sorting widgets (which open modals with fresh fetch),
    // this widget is always visible and needs to manually fetch latest state
    useEffect(() => {
        const fetchFreshMetadata = async () => {
            try {
                // Add timestamp to bypass cache (simple and compatible)
                const timestamp = Date.now()
                const response = await fetch(`/admin/product-categories/${data.id}?fields=+metadata&_t=${timestamp}`, {
                    credentials: "include",
                })

                if (response.ok) {
                    const freshData = await response.json()
                    const value = freshData.product_category?.metadata?.prerender === true
                    console.log(`[PRE-RENDER] Fresh fetch for ${data.id}: prerender=${value}`)
                    setPrerender(value)
                }
            } catch (error) {
                console.error("[PRE-RENDER] Failed to fetch fresh metadata:", error)
                // Fallback to cached data if fetch fails
                setPrerender(data.metadata?.prerender === true)
            } finally {
                setIsLoading(false)
            }
        }

        fetchFreshMetadata()
    }, [data.id]) // Re-fetch when navigating to different category

    const handleToggle = async (checked: boolean) => {
        setPrerender(checked)
        setIsSaving(true)

        try {
            // CRITICAL: Fetch current metadata first to avoid overwriting other fields
            const fetchResponse = await fetch(`/admin/product-categories/${data.id}?fields=+metadata`, {
                credentials: "include",
            })

            if (!fetchResponse.ok) throw new Error("Failed to fetch category")

            const categoryData = await fetchResponse.json()
            const existingMetadata = categoryData.product_category?.metadata || {}

            const response = await fetch(`/admin/product-categories/${data.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...existingMetadata,
                        prerender: checked,
                    },
                }),
            })

            if (!response.ok) throw new Error("Failed to update category")

            console.log(`[PRE-RENDER] Updated category ${data.id}: prerender=${checked}`)

            // No refetch needed - local state already updated via setPrerender()
            // Matches pattern from sorting widgets (ManageProductSortingModal, etc.)
        } catch (error) {
            console.error("[PRE-RENDER] Failed to update:", error)
            // Revert on error
            setPrerender(!checked)
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <div className="flex-1">
                    <Heading level="h2">Pre-Render</Heading>
                    <Text className="text-ui-fg-subtle text-sm mt-1">
                        Enable static page generation for this category
                    </Text>
                </div>
                <div className="flex items-center gap-3">
                    <Label htmlFor="category-prerender-toggle" className="text-sm">
                        {prerender ? "Yes" : "No"}
                    </Label>
                    <Switch
                        id="category-prerender-toggle"
                        checked={prerender}
                        onCheckedChange={handleToggle}
                        disabled={isSaving || isLoading}
                    />
                </div>
            </div>

            {/* Info section */}
            <div className="px-6 py-3 bg-ui-bg-subtle">
                <Text className="text-xs text-ui-fg-muted">
                    <strong>Yes:</strong> Generate static page at build time (faster load)
                    <br />
                    <strong>No:</strong> Hybrid rendering (dynamic content on each visit)
                </Text>
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.after",
})

export default CategoryPrerenderWidget
