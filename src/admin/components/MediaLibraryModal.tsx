import { Drawer, Input, Button } from "@medusajs/ui"
import { Photo, MagnifyingGlass } from "@medusajs/icons"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BASE_URL } from "../../lib/sdk"

interface MediaLibraryModalProps {
    open: boolean
    onClose: () => void
    onSelect: (urls: string | string[]) => void
    multiple?: boolean
    title?: string
}

export const MediaLibraryModal = ({
    open,
    onClose,
    onSelect,
    multiple = false,
    title = "Media Library"
}: MediaLibraryModalProps) => {
    const [currentPrefix, setCurrentPrefix] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    const [selectedUrls, setSelectedUrls] = useState<string[]>([])
    const [continuationToken, setContinuationToken] = useState<string | null>(null)
    const [pageHistory, setPageHistory] = useState<(string | null)[]>([null])

    const { data, isLoading } = useQuery({
        queryKey: ["media_files", currentPrefix, continuationToken, searchQuery],
        enabled: open,
        refetchOnMount: true,
        queryFn: async () => {
            const params = new URLSearchParams()
            if (currentPrefix) params.set("prefix", currentPrefix)
            if (continuationToken) params.set("continuationToken", continuationToken)
            if (searchQuery) params.set("search", searchQuery)

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
        setContinuationToken(null)
        setPageHistory([null])
    }

    const handleBackClick = () => {
        const parts = currentPrefix.split("/").filter(Boolean)
        parts.pop()
        setCurrentPrefix(parts.length > 0 ? parts.join("/") + "/" : "")
        setSearchQuery("")
        setContinuationToken(null)
        setPageHistory([null])
    }

    const handleNextPage = () => {
        if (data?.nextContinuationToken) {
            setPageHistory([...pageHistory, continuationToken])
            setContinuationToken(data.nextContinuationToken)
        }
    }

    const handlePreviousPage = () => {
        if (pageHistory.length > 1) {
            const newHistory = [...pageHistory]
            newHistory.pop()
            setPageHistory(newHistory)
            setContinuationToken(newHistory[newHistory.length - 1])
        }
    }

    const handleFileClick = (url: string) => {
        if (multiple) {
            setSelectedUrls(prev =>
                prev.includes(url)
                    ? prev.filter(u => u !== url)
                    : [...prev, url]
            )
        } else {
            onSelect(url)
            handleClose()
        }
    }

    const handleConfirmSelection = () => {
        if (multiple && selectedUrls.length > 0) {
            onSelect(selectedUrls)
            handleClose()
        }
    }

    const handleClose = () => {
        setCurrentPrefix("")
        setSearchQuery("")
        setSelectedUrls([])
        setContinuationToken(null)
        setPageHistory([null])
        onClose()
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
            if (!isOpen) handleClose()
        }}>
            <Drawer.Content className="w-screen max-w-none right-0 h-full">
                <Drawer.Header>
                    <Drawer.Title>{title} ({data?.count || 0} items)</Drawer.Title>
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
                            {filteredFiles.map((file: any) => {
                                const isSelected = selectedUrls.includes(file.url)
                                return (
                                    <div
                                        key={file.id}
                                        className={`relative group aspect-square border rounded-lg overflow-hidden cursor-pointer hover:border-ui-border-interactive hover:shadow-lg transition-all ${isSelected ? 'border-blue-500 border-2' : ''
                                            }`}
                                        onClick={() => handleFileClick(file.url)}
                                    >
                                        <img src={file.url} className="w-full h-full object-cover" alt={file.name} />
                                        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        {isSelected && (
                                            <div className="absolute top-2 right-2 bg-blue-500 rounded-full p-1">
                                                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                                </svg>
                                            </div>
                                        )}
                                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-white text-xs truncate opacity-0 group-hover:opacity-100 transition-opacity">
                                            {file.name}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {/* Pagination Controls */}
                    {!searchQuery && (filteredFolders.length > 0 || filteredFiles.length > 0) && (
                        <div className="flex justify-between items-center mt-4 pt-4 border-t border-ui-border-base">
                            <Button
                                onClick={handlePreviousPage}
                                disabled={pageHistory.length <= 1}
                                variant="secondary"
                                size="small"
                            >
                                ← Previous
                            </Button>
                            <span className="text-sm text-ui-fg-subtle">
                                Page {pageHistory.length}
                                {data?.isTruncated && " of many"}
                            </span>
                            <Button
                                onClick={handleNextPage}
                                disabled={!data?.nextContinuationToken}
                                variant="secondary"
                                size="small"
                            >
                                Next →
                            </Button>
                        </div>
                    )}
                </Drawer.Body>
                {multiple && (
                    <Drawer.Footer className="border-t p-4">
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-ui-fg-subtle">
                                {selectedUrls.length} selected
                            </span>
                            <div className="flex gap-2">
                                <Button variant="secondary" onClick={handleClose}>
                                    Cancel
                                </Button>
                                <Button
                                    onClick={handleConfirmSelection}
                                    disabled={selectedUrls.length === 0}
                                >
                                    Add {selectedUrls.length} image{selectedUrls.length !== 1 ? 's' : ''}
                                </Button>
                            </div>
                        </div>
                    </Drawer.Footer>
                )}
            </Drawer.Content>
        </Drawer>
    )
}
