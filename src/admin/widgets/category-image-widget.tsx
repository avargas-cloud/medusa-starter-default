import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Button, IconButton, toast, clx } from "@medusajs/ui"
import { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { Trash, Photo, CloudArrowUp, Spinner } from "@medusajs/icons"
import { useState, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../../lib/sdk"

// Widget to display and edit category image in sidebar
const CategoryImageWidget = ({
    data
}: DetailWidgetProps<AdminProductCategory>) => {
    const queryClient = useQueryClient()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [uploading, setUploading] = useState(false)

    // Resolve current (or optimistic) thumbnail
    const category = data as AdminProductCategory & { thumbnail?: string | null }
    const thumbnailUrl = category.thumbnail || (category.metadata?.thumbnail as string)

    // UPDATE MUTATION (Update Metadata)
    const updateCategory = useMutation({
        mutationFn: async (payload: { metadata: { thumbnail: string | null } }) => {
            return sdk.client.fetch(`/admin/product-categories/${data.id}`, {
                method: "POST",
                body: payload
            })
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["product_category"] })
            // Invalidate list as well if needed
            queryClient.invalidateQueries({ queryKey: ["product_categories"] })
            toast.success("Category updated")
        },
        onError: (err) => {
            toast.error("Update failed", { description: (err as Error).message })
        }
    })

    // UPLOAD MUTATION
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        setUploading(true)
        const formData = new FormData()
        formData.append("files", file)

        try {
            // Try standard V2 upload endpoint
            // Note: If using a specific file module provider, ensure this endpoint is active.
            const res = await sdk.client.fetch<{ files: { url: string }[] }>("/admin/files", {
                method: "POST",
                body: formData
            })

            const url = res.files?.[0]?.url
            if (!url) throw new Error("No URL returned from upload")

            // Update Category with new URL
            updateCategory.mutate({ metadata: { thumbnail: url } })

        } catch (err: any) {
            // Fallback to /admin/uploads (Legacy/V1 compat or common alternative)
            try {
                const legacyRes = await sdk.client.fetch<{ uploads: { url: string }[] }>("/admin/uploads", {
                    method: "POST",
                    body: formData
                })
                const urlLegacy = legacyRes.uploads?.[0]?.url
                if (urlLegacy) {
                    updateCategory.mutate({ metadata: { thumbnail: urlLegacy } })
                    return
                }
                throw err
            } catch (innerErr) {
                toast.error("Upload failed", { description: err.message })
            }
        } finally {
            setUploading(false)
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    const handleRemove = () => {
        updateCategory.mutate({ metadata: { thumbnail: null } })
    }

    return (
        <Container className="divide-y p-0 overflow-hidden bg-ui-bg-base shadow-elevation-card">
            <div className="flex flex-col gap-4 px-6 py-4">
                <div className="flex items-center justify-between">
                    <Heading level="h2">Category Image</Heading>
                    {thumbnailUrl && (
                        <IconButton
                            size="small"
                            variant="transparent"
                            className="text-ui-fg-error hover:bg-ui-bg-subtle-hover"
                            onClick={handleRemove}
                            disabled={updateCategory.isPending}
                        >
                            <Trash />
                        </IconButton>
                    )}
                </div>

                {thumbnailUrl ? (
                    <div className="relative group rounded-lg overflow-hidden border border-ui-border-base">
                        <img
                            src={thumbnailUrl}
                            alt={data.name}
                            className="w-full h-auto object-cover max-h-[300px]"
                        />
                        {/* Overlay for quick replace? */}
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Button
                                variant="secondary"
                                onClick={() => fileInputRef.current?.click()}
                                isLoading={uploading}
                            >
                                <CloudArrowUp /> Replace
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-ui-border-strong rounded-lg bg-ui-bg-subtle/50 hover:bg-ui-bg-subtle transition-colors">
                        <div className="p-2 bg-ui-bg-base rounded-full shadow-sm text-ui-fg-subtle">
                            <Photo />
                        </div>
                        <div className="flex flex-col items-center">
                            <Button
                                variant="transparent"
                                onClick={() => fileInputRef.current?.click()}
                                isLoading={uploading}
                                className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
                            >
                                {uploading ? "Uploading..." : "Upload Image"}
                            </Button>
                            <span className="text-xs text-ui-fg-muted">Supports JPG, PNG, WEBP</span>
                        </div>
                    </div>
                )}

                {/* Hidden File Input */}
                <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileChange}
                />
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.side.after",
})

export default CategoryImageWidget
