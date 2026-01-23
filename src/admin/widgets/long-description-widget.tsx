import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Textarea, Button, toast, Text, Label, Switch } from "@medusajs/ui"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { useState, useEffect } from "react"
import { BASE_URL } from "../../lib/sdk"

const LongDescriptionWidget = ({ data: productData }: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()
    const [htmlContent, setHtmlContent] = useState("")
    const [isHTMLMode, setIsHTMLMode] = useState(true) // Default to HTML mode for existing content

    // Fetch product metadata
    const { data: response } = useQuery({
        queryFn: async () => {
            const res = await fetch(
                `${BASE_URL}/admin/products/${productData.id}?fields=+metadata`,
                { credentials: "include" }
            )
            if (!res.ok) throw new Error("Failed to fetch product")
            return res.json()
        },
        queryKey: ["product", productData.id, "long-desc"],
    })

    // Sync state when data loads
    useEffect(() => {
        if (response?.product?.metadata?.long_description) {
            setHtmlContent(response.product.metadata.long_description as string)
        }
    }, [response])

    // Update mutation
    const updateProduct = useMutation({
        mutationFn: async (content: string) => {
            const res = await fetch(`${BASE_URL}/admin/products/${productData.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...response?.product?.metadata,
                        long_description: content,
                    },
                })
            })
            if (!res.ok) throw new Error("Failed to save long description")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Long Description saved")
            queryClient.invalidateQueries({ queryKey: ["product", productData.id] })
        },
        onError: (err) => {
            toast.error("Failed to save", { description: (err as Error).message })
        }
    })

    const handleSave = () => {
        updateProduct.mutate(htmlContent)
    }

    // Convert HTML to plain text for Text mode display
    const getPlainText = (html: string): string => {
        if (!html) return ""
        // Create a temporary div to parse HTML
        const temp = document.createElement("div")
        temp.innerHTML = html
        // Get text content (strips all HTML tags)
        return temp.textContent || temp.innerText || ""
    }

    // Get display value based on mode
    const displayValue = isHTMLMode ? htmlContent : getPlainText(htmlContent)

    return (
        <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">Long Description</Heading>
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <Label size="small" className="text-ui-fg-subtle">
                            {isHTMLMode ? "HTML" : "Text"}
                        </Label>
                        <Switch
                            checked={isHTMLMode}
                            onCheckedChange={setIsHTMLMode}
                        />
                    </div>
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={handleSave}
                        isLoading={updateProduct.isPending}
                    >
                        Save
                    </Button>
                </div>
            </div>

            <div className="px-6 py-4">
                <div className="flex flex-col gap-2">
                    {isHTMLMode ? (
                        <>
                            <Label size="small" weight="plus">
                                HTML Source Code
                            </Label>
                            <Textarea
                                value={htmlContent}
                                onChange={(e) => setHtmlContent(e.target.value)}
                                placeholder="<p>Enter HTML here...</p>"
                                rows={15}
                                className="font-mono text-xs bg-ui-bg-field border-ui-border-base"
                            />
                            <Text size="small" className="text-ui-fg-muted">
                                HTML mode: Edit raw HTML markup. This content will render as-is in your storefront.
                            </Text>
                        </>
                    ) : (
                        <>
                            <Label size="small" weight="plus">
                                Content (Preview)
                            </Label>
                            <Textarea
                                value={displayValue}
                                readOnly
                                placeholder="No content"
                                rows={15}
                                className="bg-ui-bg-field border-ui-border-base"
                            />
                            <Text size="small" className="text-ui-fg-muted">
                                Text mode: Preview without HTML tags. Switch to HTML mode to edit.
                            </Text>
                        </>
                    )}
                </div>
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.after",
})

export default LongDescriptionWidget
