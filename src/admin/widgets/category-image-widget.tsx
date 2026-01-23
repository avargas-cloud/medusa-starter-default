import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Button, IconButton, toast, Drawer, Input } from "@medusajs/ui"
import { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { Trash, Photo, CloudArrowUp, MagnifyingGlass } from "@medusajs/icons"
import { useState, useRef } from "react"
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query"
import { BASE_URL } from "../../lib/sdk"

const MediaLibraryModal = ({
    open,
    onClose,
    onSelect
}: {
    open: boolean,
    onClose: () => void,
    onSelect: (url: string) => void
}) => {
    const [currentPrefix, setCurrentPrefix] = useState("")
    const [searchQuery, setSearchQuery] = useState("")

    const { data, isLoading } = useQuery({
        queryKey: ["media_files", currentPrefix],
        enabled: open,
        refetchOnMount: true,
        queryFn: async () => {
            const params = new URLSearchParams()
            if (currentPrefix) params.set("prefix", currentPrefix)

            const response = await fetch(`${BASE_URL}/admin/media?${params.toString()}`, {
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
            })
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText }))
                throw new Error(errorData.message || "Failed to fetch media")
            }
            return response.json()
        }
    })

    const handleFolderClick = (prefix: string) => {
        setCurrentPrefix(prefix)
        setSearchQuery("")
    }

    const handleBackClick = () => {
        const parts = currentPrefix.split("/").filter(Boolean)
        parts.pop()
        setCurrentPrefix(parts.length > 0 ? parts.join("/") + "/" : "")
        setSearchQuery("")
    }

    const breadcrumbs = currentPrefix ? currentPrefix.split("/").filter(Boolean) : []

    // Filter files and folders by search query
    const filteredFolders = (data?.folders || []).filter((folder: any) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
    const filteredFiles = (data?.files || []).filter((file: any) =>
        file.name.toLowerCase().includes(searchQuery.toLowerCase())
    )

    return (
        <Drawer open={open} onOpenChange={(isOpen) => {
            if (!isOpen) {
                setCurrentPrefix("")
                setSearchQuery("")
                onClose()
            }
        }}>
            <Drawer.Content className="w-[80vw] max-w-[800px] right-0 h-full">
                <Drawer.Header>
                    <Drawer.Title>Media Library ({data?.count || 0} items)</Drawer.Title>
                    {breadcrumbs.length > 0 && (
                        <div className="flex items-center gap-2 text-sm text-ui-fg-subtle mt-2 flex-wrap">
                            <button onClick={() => setCurrentPrefix("")} className="hover:text-ui-fg-base hover:underline">
                                Root
                            </button>
                            {breadcrumbs.map((folder, index) => (
                                <div key={index} className="flex items-center gap-2">
                                    <span>/</span>
                                    <button
                                        onClick={() => {
                                            setCurrentPrefix(breadcrumbs.slice(0, index + 1).join("/") + "/")
                                            setSearchQuery("")
                                        }}
                                        className="hover:text-ui-fg-base hover:underline"
                                    >
                                        {folder}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </Drawer.Header>
                <Drawer.Body className="p-4 overflow-y-auto">
                    {/* Search Bar */}
                    <div className="mb-4 flex gap-2 items-center">
                        {currentPrefix && (
                            <Button
                                onClick={handleBackClick}
                                variant="secondary"
                                size="small"
                            >
                                ← Back
                            </Button>
                        )}
                        <div className="flex-1 relative">
                            <Input
                                placeholder="Search files and folders..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-8"
                            />
                            <MagnifyingGlass className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-ui-fg-subtle" />
                        </div>
                    </div>

                    {isLoading ? (
                        <div className="flex justify-center p-8 text-ui-fg-subtle">Loading library...</div>
                    ) : (filteredFolders.length === 0 && filteredFiles.length === 0) ? (
                        <div className="flex flex-col items-center justify-center p-8 text-ui-fg-subtle">
                            <Photo className="w-12 h-12 mb-4 opacity-40" />
                            <p className="font-medium">
                                {searchQuery ? "No results found" : "No items in this folder"}
                            </p>
                            {searchQuery && (
                                <p className="text-sm mt-2">Try a different search term</p>
                            )}
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-4">
                            {filteredFolders.map((folder: any) => (
                                <div
                                    key={folder.id}
                                    className="relative group aspect-square border-2 border-dashed rounded-lg overflow-hidden cursor-pointer hover:border-ui-border-interactive bg-ui-bg-subtle flex items-center justify-center transition-all hover:bg-ui-bg-base"
                                    onClick={() => handleFolderClick(folder.prefix)}
                                >
                                    <div className="text-center p-4">
                                        <div className="w-16 h-16 mx-auto mb-2 bg-ui-bg-base rounded-lg flex items-center justify-center">
                                            <Photo className="w-8 h-8 text-ui-fg-subtle" />
                                        </div>
                                        <p className="text-sm font-medium truncate">{folder.name}</p>
                                    </div>
                                </div>
                            ))}
                            {filteredFiles.map((file: any) => (
                                <div
                                    key={file.id}
                                    className="relative group aspect-square border rounded-lg overflow-hidden cursor-pointer hover:border-ui-border-interactive hover:shadow-lg transition-all"
                                    onClick={() => onSelect(file.url)}
                                >
                                    <img src={file.url} className="w-full h-full object-cover" alt={file.name} />
                                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-white text-xs truncate opacity-0 group-hover:opacity-100 transition-opacity">
                                        {file.name}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Drawer.Body>
            </Drawer.Content>
        </Drawer>
    )
}

const CategoryImageWidget = ({
    data
}: DetailWidgetProps<AdminProductCategory>) => {
    const queryClient = useQueryClient()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [uploading, setUploading] = useState(false)
    const [showMediaLibrary, setShowMediaLibrary] = useState(false)

    const category = data as AdminProductCategory & { thumbnail?: string | null }
    const thumbnailUrl = category.thumbnail || (category.metadata?.thumbnail as string)

    const updateCategory = useMutation({
        mutationFn: async (payload: { metadata: { thumbnail: string | null } }) => {
            const response = await fetch(`${BASE_URL}/admin/product-categories/${data.id}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify(payload)
            })
            if (!response.ok) throw new Error("Update failed")
            return response.json()
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["product_category"] })
            queryClient.invalidateQueries({ queryKey: ["product_categories"] })
            toast.success("Category updated")
        },
        onError: (err) => {
            toast.error("Update failed", { description: (err as Error).message })
        }
    })

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        setUploading(true)
        const formData = new FormData()
        formData.append("files", file)

        try {
            const res = await fetch(`${BASE_URL}/admin/files`, {
                method: "POST",
                credentials: "include",
                body: formData
            }).then(r => r.json())

            const url = res.files?.[0]?.url
            if (!url) throw new Error("No URL returned from upload")

            updateCategory.mutate({ metadata: { thumbnail: url } })

        } catch (err: any) {
            try {
                const legacyRes = await fetch(`${BASE_URL}/admin/uploads`, {
                    method: "POST",
                    credentials: "include",
                    body: formData
                }).then(r => r.json())

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

    const handleSelectFromLibrary = (url: string) => {
        updateCategory.mutate({ metadata: { thumbnail: url } })
        setShowMediaLibrary(false)
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
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            <Button
                                variant="secondary"
                                onClick={() => fileInputRef.current?.click()}
                                isLoading={uploading}
                            >
                                <CloudArrowUp /> Replace
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={() => setShowMediaLibrary(true)}
                            >
                                <Photo /> Library
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-ui-border-strong rounded-lg bg-ui-bg-subtle/50 hover:bg-ui-bg-subtle transition-colors">
                        <div className="p-2 bg-ui-bg-base rounded-full shadow-sm text-ui-fg-subtle">
                            <Photo />
                        </div>
                        <div className="flex flex-col items-center gap-2">
                            <div className="flex gap-2">
                                <Button
                                    variant="secondary"
                                    onClick={() => fileInputRef.current?.click()}
                                    isLoading={uploading}
                                >
                                    Upload
                                </Button>
                                <Button
                                    variant="transparent"
                                    onClick={() => setShowMediaLibrary(true)}
                                >
                                    Select from Library
                                </Button>
                            </div>
                            <span className="text-xs text-ui-fg-muted">Supports JPG, PNG, WEBP</span>
                        </div>
                    </div>
                )}

                <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileChange}
                />

                <MediaLibraryModal
                    open={showMediaLibrary}
                    onClose={() => setShowMediaLibrary(false)}
                    onSelect={handleSelectFromLibrary}
                />
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product_category.details.side.after",
})

export default CategoryImageWidget
