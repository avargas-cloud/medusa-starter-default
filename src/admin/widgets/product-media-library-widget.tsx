import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, toast } from "@medusajs/ui"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Photo } from "@medusajs/icons"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { MediaLibraryModal } from "../components/MediaLibraryModal"
import { BASE_URL } from "../../lib/sdk"

const ProductMediaLibraryWidget = ({
    data
}: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()
    const [showMediaLibrary, setShowMediaLibrary] = useState(false)
    const [uploadPanel, setUploadPanel] = useState<Element | null>(null)

    const addImagesToProduct = useMutation({
        mutationFn: async (imageUrls: string[]) => {
            const currentImages = data.images || []
            const allImages = [
                ...currentImages.map(img => ({ url: img.url })),
                ...imageUrls.map(url => ({ url }))
            ]

            const response = await fetch(`${BASE_URL}/admin/products/${data.id}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    images: allImages
                })
            })
            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.message || "Failed to add images")
            }
            return response.json()
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["product"] })
            queryClient.invalidateQueries({ queryKey: ["products"] })
            queryClient.refetchQueries({ queryKey: ["product", data.id] })

            toast.success("Images added successfully", {
                description: `${addImagesToProduct.variables?.length || 0} image(s) added from MinIO.`
            })

            // Auto-close Gallery modal after 1.5 seconds
            setTimeout(() => {
                const dialogs = document.querySelectorAll('[role="dialog"]')
                for (const dialog of dialogs) {
                    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find(b =>
                        b.textContent?.toLowerCase().includes('cancel')
                    ) as HTMLButtonElement

                    if (cancelBtn) {
                        cancelBtn.click()
                        break
                    }
                }
            }, 1500)
        },
        onError: (err) => {
            toast.error("Failed to add images", {
                description: (err as Error).message
            })
        }
    })

    const handleSelectFromLibrary = (urls: string | string[]) => {
        const urlArray = Array.isArray(urls) ? urls : [urls]
        addImagesToProduct.mutate(urlArray)
        setShowMediaLibrary(false)
    }

    useEffect(() => {
        const findUploadPanel = () => {
            const dialogs = document.querySelectorAll('[role="dialog"]')

            for (const dialog of dialogs) {
                const allButtons = Array.from(dialog.querySelectorAll('button'))
                const uploadButton = allButtons.find(btn =>
                    btn.textContent?.toLowerCase().includes('upload images')
                )

                if (uploadButton) {
                    let container = uploadButton.parentElement
                    let depth = 0

                    while (container && depth < 10) {
                        const hasDragText = container.textContent?.includes('Drag and drop')
                        const hasMediaText = container.textContent?.includes('Media')

                        if (hasDragText && hasMediaText) {
                            setUploadPanel(container)
                            return true
                        }

                        container = container.parentElement
                        depth++
                    }

                    const fallback = uploadButton.parentElement?.parentElement
                    if (fallback) {
                        setUploadPanel(fallback)
                        return true
                    }
                }
            }

            return false
        }

        const observer = new MutationObserver(() => {
            const hasDialog = document.querySelector('[role="dialog"]')

            if (hasDialog && !uploadPanel) {
                setTimeout(findUploadPanel, 150)
            } else if (!hasDialog && uploadPanel) {
                setUploadPanel(null)
            }
        })

        observer.observe(document.body, {
            childList: true,
            subtree: true
        })

        findUploadPanel()

        return () => observer.disconnect()
    }, [uploadPanel])

    if (!uploadPanel) {
        return null
    }

    return (
        <>
            {createPortal(
                <div className="mt-4 border-t border-ui-border-base pt-4">
                    <Button
                        variant="secondary"
                        type="button"
                        onClick={() => setShowMediaLibrary(true)}
                        isLoading={addImagesToProduct.isPending}
                        className="w-full"
                    >
                        <Photo className="w-4 h-4 mr-2" />
                        Select from Library (MinIO)
                    </Button>
                </div>,
                uploadPanel
            )}

            <MediaLibraryModal
                open={showMediaLibrary}
                onClose={() => setShowMediaLibrary(false)}
                onSelect={handleSelectFromLibrary}
                multiple={true}
                title="Select Product Images from MinIO"
            />
        </>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.before",
})

export default ProductMediaLibraryWidget
