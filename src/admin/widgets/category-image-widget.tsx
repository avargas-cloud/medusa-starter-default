// ... imports ...
import { Drawer, clx } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { CheckCircleSolid } from "@medusajs/icons"

// ... existing widget code ...

const MediaLibraryModal = ({
    open,
    onClose,
    onSelect
}: {
    open: boolean,
    onClose: () => void,
    onSelect: (url: string) => void
}) => {
    const { data, isLoading } = useQuery({
        queryKey: ["media_files"],
        queryFn: async () => sdk.client.fetch<{ files: any[] }>("/admin/media")
    })

    return (
        <Drawer open={open} onOpenChange={onClose}>
            <Drawer.Content className="w-[80vw] max-w-[800px] right-0 h-full">
                <Drawer.Header>
                    <Drawer.Title>Media Library</Drawer.Title>
                </Drawer.Header>
                <Drawer.Body className="p-4 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex justify-center p-8"><Spinner /></div>
                    ) : (
                        <div className="grid grid-cols-3 gap-4">
                            {data?.files?.map((file) => (
                                <div
                                    key={file.id}
                                    className="relative group aspect-square border rounded-lg overflow-hidden cursor-pointer hover:border-ui-border-interactive"
                                    onClick={() => onSelect(file.url)}
                                >
                                    <img src={file.url} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity" />
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
    // ... existing state ...
    const [showMediaLibrary, setShowMediaLibrary] = useState(false)

    // ... existing mutations ...

    const handleSelectFromLibrary = (url: string) => {
        updateCategory.mutate({ metadata: { thumbnail: url } })
        setShowMediaLibrary(false)
    }

    return (
        <Container className="divide-y p-0 overflow-hidden bg-ui-bg-base shadow-elevation-card">
            <div className="flex flex-col gap-4 px-6 py-4">
                {/* ... Header ... */}
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
                    // ... Existing Image View ...
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
                    // ... Empty View ...
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

                {/* Hidden File Input */}
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
