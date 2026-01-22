import { defineRouteConfig } from "@medusajs/admin-sdk"
import { TagSolid, EllipsisHorizontal, PencilSquare, Trash, Plus, ChevronDown, ChevronRight } from "@medusajs/icons"
import {
    Container,
    Heading,
    Text,
    Button,
    IconButton,
    toast,
    Checkbox,
    DropdownMenu,
    Badge,
    clx
} from "@medusajs/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { CreateAttributeModal } from "../../components/attributes/create-attribute-modal"
import { CreateSetModal } from "../../components/attributes/create-set-modal"
import { RenameSetModal } from "../../components/attributes/rename-set-modal"
import { DeleteSetModal } from "../../components/attributes/delete-set-modal"

// CONFIGURACIÓN
export const config = defineRouteConfig({
    label: "Attributes",
    icon: TagSolid,
    nested: "/products",
})

export default function AttributesPage() {
    const navigate = useNavigate()
    const queryClient = useQueryClient()

    // STATE
    const [searchValue, setSearchValue] = useState("")
    const [selectedAttributes, setSelectedAttributes] = useState<Set<string>>(new Set())

    // CUSTOM ACCORDION STATE
    const [expandedSets, setExpandedSets] = useState<Set<string>>(new Set(["unassigned"]))

    const toggleSet = (setId: string) => {
        const newExpanded = new Set(expandedSets)
        if (newExpanded.has(setId)) {
            newExpanded.delete(setId)
        } else {
            newExpanded.add(setId)
        }
        setExpandedSets(newExpanded)
    }

    // MODALS STATE
    const [createModalOpen, setCreateModalOpen] = useState(false) // Set Modal
    const [createAttributeModalOpen, setCreateAttributeModalOpen] = useState(false) // Attribute Modal (NEW)
    const [renameModalOpen, setRenameModalOpen] = useState(false)
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [targetSet, setTargetSet] = useState<{ id: string, title: string } | null>(null)

    // QUERIES
    const { data: setsData, isLoading: setsLoading } = useQuery({
        queryKey: ["attribute-sets"],
        queryFn: async () => {
            const res = await fetch(`/admin/attribute-sets`)
            if (!res.ok) throw new Error("Failed to fetch sets")
            return res.json()
        },
        staleTime: 1000 * 60 * 5, // 5 minutes cache
    })

    const { data: attributesData, isLoading: attributesLoading } = useQuery({
        queryKey: ["attributes"],
        queryFn: async () => {
            const res = await fetch(`/admin/attributes`)
            if (!res.ok) throw new Error("Failed to fetch attributes")
            return res.json()
        },
        staleTime: 1000 * 60 * 5, // 5 minutes cache
    })

    // DATA PROCESSING
    const attributes: any[] = Array.isArray(attributesData?.attribute_keys)
        ? attributesData.attribute_keys
        : []

    const sets: any[] = Array.isArray(setsData?.attribute_sets)
        ? setsData.attribute_sets
        : []

    // Grouping
    const unassignedAttributes = useMemo(() =>
        attributes.filter(a => !a.attribute_set_id),
        [attributes])

    // Filtering
    const filterAttributes = (list: any[]) => {
        if (!searchValue) return list
        const lower = searchValue.toLowerCase()
        return list.filter(a =>
            a.label.toLowerCase().includes(lower) ||
            a.handle.toLowerCase().includes(lower)
        )
    }

    // BULK ACTIONS
    const handleSelect = (id: string) => {
        const newSelected = new Set(selectedAttributes)
        if (newSelected.has(id)) newSelected.delete(id)
        else newSelected.add(id)
        setSelectedAttributes(newSelected)
    }

    const handleSelectAll = (subset: any[]) => {
        const newSelected = new Set(selectedAttributes)
        const allSelected = subset.every(a => newSelected.has(a.id))

        if (allSelected) {
            subset.forEach(a => newSelected.delete(a.id))
        } else {
            subset.forEach(a => newSelected.add(a.id))
        }
        setSelectedAttributes(newSelected)
    }

    const handleBulkMove = async (targetSetId: string | null) => {
        if (selectedAttributes.size === 0) return

        try {
            const res = await fetch("/admin/attributes/bulk-move", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    attribute_ids: Array.from(selectedAttributes),
                    target_set_id: targetSetId
                })
            })

            if (!res.ok) throw new Error("Bulk move failed")

            toast.success("Attributes moved", {
                description: `Moved ${selectedAttributes.size} attributes`
            })

            setSelectedAttributes(new Set()) // Clear selection
            queryClient.invalidateQueries({ queryKey: ["attributes"] })
        } catch (err) {
            toast.error("Error", { description: (err as Error).message })
        }
    }

    // HANDLERS
    const openRename = (set: any) => {
        setTargetSet({ id: set.id, title: set.title })
        setRenameModalOpen(true)
    }

    const openDelete = (set: any) => {
        setTargetSet({ id: set.id, title: set.title })
        setDeleteModalOpen(true)
    }

    // RENDERERS
    const renderAttributeRow = (attr: any) => (
        <div
            key={attr.id}
            className="flex items-center gap-4 py-3 px-2 hover:bg-ui-bg-subtle-hover group rounded-md cursor-pointer"
            onClick={(e) => {
                // Prevent navigation if clicking checkbox or action
                if ((e.target as HTMLElement).closest("button") || (e.target as HTMLElement).closest("[role='checkbox']")) return
                navigate(`/attributes/${attr.id}`)
            }}
        >
            <Checkbox
                checked={selectedAttributes.has(attr.id)}
                onCheckedChange={() => handleSelect(attr.id)}
            />
            <div className="flex-1 flex items-center gap-3">
                <Text size="small" weight="plus" className="text-ui-fg-base">
                    {attr.label}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                    ({attr.handle})
                </Text>
            </div>

            {/* Show options count badge only, NO expanded values */}
            <Badge size="small">
                {attr.options?.length || 0} options
            </Badge>

            <IconButton size="small" variant="transparent" className="opacity-0 group-hover:opacity-100 transition-opacity">
                <ChevronRight />
            </IconButton>
        </div>
    )

    if (setsLoading || attributesLoading) {
        return <Container className="h-screen flex items-center justify-center">Loading...</Container>
    }

    // RENDER
    return (
        <Container className="p-0 divide-y min-h-[600px]">
            {/* HEADER */}
            <div className="px-8 py-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <div>
                        <Heading level="h1">Product Attributes</Heading>
                        <Text className="text-ui-fg-subtle">
                            Manage your product properties and specifications
                        </Text>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="secondary" onClick={() => setCreateAttributeModalOpen(true)}>
                            <Plus /> Create Attribute
                        </Button>
                        <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
                            <Plus /> Create Set
                        </Button>
                    </div>
                </div>

                {/* BULK ACTION BAR */}
                {selectedAttributes.size > 0 && (
                    <div className="px-8 py-3 bg-ui-bg-subtle flex items-center justify-between border-b border-ui-border-base animate-in slide-in-from-top-2">
                        <div className="flex items-center gap-3">
                            <Badge color="blue">{selectedAttributes.size} selected</Badge>
                            <Button
                                variant="transparent"
                                size="small"
                                onClick={() => setSelectedAttributes(new Set())}
                            >
                                Clear selection
                            </Button>
                        </div>

                        <div className="flex items-center gap-2">
                            <Text size="small" className="text-ui-fg-subtle">Move to:</Text>
                            <DropdownMenu>
                                <DropdownMenu.Trigger asChild>
                                    <Button variant="secondary" size="small">
                                        Select Destination
                                    </Button>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content>
                                    <DropdownMenu.Item onClick={() => handleBulkMove(null)}>
                                        Unassigned
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Separator />
                                    {sets.map(set => (
                                        <DropdownMenu.Item key={set.id} onClick={() => handleBulkMove(set.id)}>
                                            {set.title}
                                        </DropdownMenu.Item>
                                    ))}
                                </DropdownMenu.Content>
                            </DropdownMenu>
                        </div>
                    </div>
                )}
                <div className="flex items-center gap-4">
                    <input
                        type="search"
                        placeholder="Search attributes..."
                        value={searchValue}
                        onChange={(e) => setSearchValue(e.target.value)}
                        className="flex-1 bg-ui-bg-field border border-ui-border-base rounded-md px-3 py-1.5 text-sm"
                    />
                </div>
            </div>

            {/* ... rest of the component (bulk actions, accordion) ... */}

            {/* ... list content ... */}
            <div className="px-6 py-4 flex flex-col gap-3">
                {/* ... */}
                {/* UNASSIGNED SET */}
                <div className="border border-ui-border-base rounded-lg bg-ui-bg-base overflow-hidden">
                    <div
                        className="px-4 py-3 hover:bg-ui-bg-subtle-hover cursor-pointer flex items-center justify-between select-none"
                        onClick={() => toggleSet("unassigned")}
                    >
                        <div className="flex items-center gap-2">
                            {expandedSets.has("unassigned") ? <ChevronDown className="text-ui-fg-subtle" /> : <ChevronRight className="text-ui-fg-subtle" />}
                            <Text weight="plus">Unassigned Attributes</Text>
                            <Badge size="small" color="grey">{unassignedAttributes.length}</Badge>
                        </div>
                    </div>

                    {expandedSets.has("unassigned") && (
                        <div className="px-4 pb-4 pt-1 border-t border-ui-border-base/50">
                            <div className="mb-2 flex items-center gap-2 mt-2">
                                <Button
                                    variant="transparent"
                                    size="small"
                                    onClick={() => handleSelectAll(filterAttributes(unassignedAttributes))}
                                >
                                    Select All
                                </Button>
                            </div>
                            <div className="flex flex-col divide-y divide-ui-border-base/50">
                                {filterAttributes(unassignedAttributes).length > 0 ? (
                                    filterAttributes(unassignedAttributes).map(renderAttributeRow)
                                ) : (
                                    <Text className="text-ui-fg-muted italic py-2">No unassigned attributes</Text>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* CUSTOM SETS */}
                {sets.map(set => {
                    const setAttributes = attributes.filter(a => a.attribute_set_id === set.id)
                    const filtered = filterAttributes(setAttributes)

                    // Hide set if searching and no matches in it
                    if (searchValue && filtered.length === 0) return null

                    return (
                        <div key={set.id} className="border border-ui-border-base rounded-lg bg-ui-bg-base overflow-hidden">
                            <div
                                className="px-4 py-3 hover:bg-ui-bg-subtle-hover cursor-pointer group flex items-center justify-between select-none"
                                onClick={() => toggleSet(set.id)}
                            >
                                <div className="flex items-center gap-2">
                                    {expandedSets.has(set.id) ? <ChevronDown className="text-ui-fg-subtle" /> : <ChevronRight className="text-ui-fg-subtle" />}

                                    <div className="flex items-center gap-2">
                                        <Text weight="plus">{set.title}</Text>

                                        {/* Rename Icon - Visible on Hover */}
                                        <IconButton
                                            variant="transparent"
                                            size="small"
                                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                openRename(set)
                                            }}
                                        >
                                            <PencilSquare className="text-ui-fg-subtle" />
                                        </IconButton>
                                    </div>

                                    <Badge size="small">{filtered.length}</Badge>
                                </div>

                                {/* Delete Icon - Visible on Hover */}
                                <div
                                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <IconButton
                                        variant="transparent"
                                        size="small"
                                        className="text-ui-fg-subtle hover:text-ui-fg-error"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            openDelete(set)
                                        }}
                                    >
                                        <Trash />
                                    </IconButton>
                                </div>
                            </div>

                            {expandedSets.has(set.id) && (
                                <div className="px-4 pb-4 pt-1 border-t border-ui-border-base/50">
                                    <div className="mb-2 flex items-center gap-2 mt-2">
                                        <Button
                                            variant="transparent"
                                            size="small"
                                            onClick={() => handleSelectAll(filtered)}
                                        >
                                            Select All
                                        </Button>
                                    </div>
                                    <div className="flex flex-col divide-y divide-ui-border-base/50">
                                        {filtered.length > 0 ? (
                                            filtered.map(renderAttributeRow)
                                        ) : (
                                            <Text className="text-ui-fg-muted italic py-2">No attributes in this set</Text>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* MODALS */}
            <CreateAttributeModal
                open={createAttributeModalOpen}
                onOpenChange={setCreateAttributeModalOpen}
            />

            <CreateSetModal
                open={createModalOpen}
                onOpenChange={setCreateModalOpen}
            />

            <RenameSetModal
                open={renameModalOpen}
                onOpenChange={setRenameModalOpen}
                set={targetSet}
            />

            <DeleteSetModal
                open={deleteModalOpen}
                onOpenChange={setDeleteModalOpen}
                set={targetSet}
            />
        </Container>
    )
}
