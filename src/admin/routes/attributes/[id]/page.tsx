import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Container, Heading, Text, Button, Table, IconButton, usePrompt, toast, Input, Label, Badge } from "@medusajs/ui"
import { Trash, ArrowLeftMini, Plus, PencilSquare, Check } from "@medusajs/icons"
import { useState, useEffect } from "react"

const AttributeDetailPage = () => {
    const { id } = useParams()
    const navigate = useNavigate()
    const prompt = usePrompt()
    const queryClient = useQueryClient()

    // UI State
    const [isEditingTitle, setIsEditingTitle] = useState(false)
    const [editTitle, setEditTitle] = useState("")
    const [newValue, setNewValue] = useState("")

    // FETCH
    const { data, isLoading } = useQuery({
        queryKey: ["attribute", id],
        queryFn: async () => {
            const res = await fetch(`/admin/attributes/${id}`)
            if (!res.ok) throw new Error("Failed to fetch attribute")
            return res.json()
        },
    })

    const attribute = data?.attribute

    // SYNC STATE
    useEffect(() => {
        if (attribute) {
            setEditTitle(attribute.label)
        }
    }, [attribute])

    // UPDATE MUTATION
    const updateAttribute = useMutation({
        mutationFn: async (payload: { label?: string; options?: string[] }) => {
            const res = await fetch(`/admin/attributes/${id}`, {
                method: "POST", // using POST as implemented
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            })
            if (!res.ok) throw new Error("Failed to update attribute")
            return res.json()
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["attribute", id] })
            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            toast.success("Saved")
            setIsEditingTitle(false)
            setNewValue("")
        },
        onError: (err) => {
            toast.error("Error", { description: (err as Error).message })
        }
    })

    // DELETE MUTATION
    const deleteAttribute = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/admin/attributes/${id}`, { method: "DELETE" })
            if (!res.ok) throw new Error("Failed to delete")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Deleted")
            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            navigate("/attributes")
        }
    })

    // HANDLERS
    const handleSaveTitle = () => {
        if (!editTitle.trim()) return
        updateAttribute.mutate({ label: editTitle })
    }

    // RENAME VALUE HANDLER
    const handleRenameValue = (oldVal: string, newVal: string) => {
        if (!attribute || !newVal.trim() || oldVal === newVal) return

        const currentOptions = attribute.options || []

        // Check duplicate
        if (currentOptions.includes(newVal.trim())) {
            toast.error("Value already exists")
            return
        }

        const newOptions = currentOptions.map(o => o === oldVal ? newVal.trim() : o)

        updateAttribute.mutate({
            label: attribute.label,
            options: newOptions
        })
    }

    // Check duplicate logic for adding
    const handleAddValue = () => {
        if (!newValue.trim() || !attribute) return
        const currentOptions = attribute.options || []
        if (currentOptions.includes(newValue.trim())) {
            toast.error("Value already exists")
            return
        }
        updateAttribute.mutate({
            label: attribute.label,
            options: [...currentOptions, newValue.trim()]
        })
    }

    const handleDeleteValue = async (valToDelete: string) => {
        if (!attribute) return

        const confirmed = await prompt({
            title: "Delete Value?",
            description: `Are you sure you want to delete "${valToDelete}"? This cannot be undone.`,
            confirmText: "Delete",
            variant: "danger"
        })

        if (!confirmed) return

        const currentOptions = attribute.options || []
        const newOptions = currentOptions.filter(o => o !== valToDelete)
        updateAttribute.mutate({
            label: attribute.label,
            options: newOptions
        })
    }

    const handleDeleteAttribute = async () => {
        const confirmed = await prompt({
            title: "Delete Attribute?",
            description: "Irreversible action.",
            confirmText: "Delete",
            variant: "danger"
        })
        if (confirmed) deleteAttribute.mutate()
    }

    if (isLoading || !attribute) return <Container>Loading...</Container>

    return (
        <div className="flex flex-col gap-4 max-w-4xl mx-auto pb-10">
            {/* NAV & HEADER */}
            <div className="flex items-center justify-between">
                <Button variant="transparent" onClick={() => navigate("/attributes")} className="gap-2 text-ui-fg-subtle">
                    <ArrowLeftMini /> Back to Attributes
                </Button>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-ui-bg-subtle px-2 py-1 rounded text-xs text-ui-fg-muted font-mono select-all">
                        <span className="font-semibold">ID:</span> {attribute.id}
                    </div>
                    <IconButton variant="transparent" className="text-ui-fg-error" onClick={handleDeleteAttribute}>
                        <Trash />
                    </IconButton>
                </div>
            </div>

            {/* MAIN CARD */}
            <Container>
                <div className="flex flex-col gap-6">
                    {/* TITLE EDIT */}
                    <div className="flex flex-col gap-2">
                        <Label className="text-ui-fg-subtle">Attribute Name</Label>
                        {isEditingTitle ? (
                            <div className="flex items-center gap-2">
                                <Input
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    autoFocus
                                />
                                <IconButton variant="primary" onClick={handleSaveTitle}>
                                    <Check />
                                </IconButton>
                                <Button variant="transparent" onClick={() => setIsEditingTitle(false)}>
                                    Cancel
                                </Button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 group">
                                <Heading level="h1">{attribute.label}</Heading>
                                <IconButton
                                    variant="transparent"
                                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={() => setIsEditingTitle(true)}
                                >
                                    <PencilSquare />
                                </IconButton>
                            </div>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                            <Badge>{attribute.handle}</Badge>
                            {attribute.attribute_set_id ? (
                                <Badge color="blue">Assigned to Set</Badge>
                            ) : (
                                <Badge color="orange">Unassigned</Badge>
                            )}
                        </div>
                    </div>

                    <div className="w-full h-px bg-ui-border-base" />

                    {/* VALUES MANAGEMENT */}
                    <div className="flex flex-col gap-6">
                        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                            <Heading level="h2">Attribute Values</Heading>
                            <div className="flex items-center gap-2 w-full md:w-auto">
                                <Input
                                    placeholder="Add value (e.g. Red)"
                                    value={newValue}
                                    onChange={(e) => setNewValue(e.target.value)}
                                    className="w-full md:w-64"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleAddValue()
                                    }}
                                />
                                <Button variant="secondary" onClick={handleAddValue} disabled={!newValue.trim()}>
                                    <Plus /> Add
                                </Button>
                            </div>
                        </div>

                        <div className="border border-ui-border-base rounded-lg overflow-hidden">
                            <Table>
                                <Table.Header>
                                    <Table.Row>
                                        <Table.HeaderCell>Value</Table.HeaderCell>
                                        <Table.HeaderCell className="w-24 text-right">Actions</Table.HeaderCell>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {attribute.options && attribute.options.length > 0 ? (
                                        attribute.options.map((val: string, idx: number) => (
                                            <ValueRow
                                                key={idx}
                                                value={val}
                                                onRename={handleRenameValue}
                                                onDelete={handleDeleteValue}
                                            />
                                        ))
                                    ) : (
                                        <Table.Row>
                                            <Table.Cell className="text-center py-8 text-ui-fg-muted italic">
                                                No values defined for this attribute. Add one above.
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </Table.Body>
                            </Table>
                        </div>
                    </div>
                </div>
            </Container>
        </div>
    )
}

// Sub-component for editable row
const ValueRow = ({ value, onRename, onDelete }: { value: string, onRename: (o: string, n: string) => void, onDelete: (v: string) => void }) => {
    const [isEditing, setIsEditing] = useState(false)
    const [editVal, setEditVal] = useState(value)

    const save = () => {
        onRename(value, editVal)
        setIsEditing(false)
    }

    if (isEditing) {
        return (
            <Table.Row>
                <Table.Cell>
                    <div className="flex items-center gap-2">
                        <Input
                            value={editVal}
                            onChange={(e) => setEditVal(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") save()
                                if (e.key === "Escape") setIsEditing(false)
                            }}
                            autoFocus
                            size="small"
                        />
                    </div>
                </Table.Cell>
                <Table.Cell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                        <IconButton variant="transparent" size="small" onClick={save}>
                            <Check />
                        </IconButton>
                        <IconButton variant="transparent" size="small" onClick={() => setIsEditing(false)}>
                            <Plus className="rotate-45" /> {/* Close icon */}
                        </IconButton>
                    </div>
                </Table.Cell>
            </Table.Row>
        )
    }

    return (
        <Table.Row className="group">
            <Table.Cell>{value}</Table.Cell>
            <Table.Cell className="text-right">
                <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton variant="transparent" size="small" onClick={() => setIsEditing(true)}>
                        <PencilSquare className="text-ui-fg-subtle" />
                    </IconButton>
                    <IconButton
                        variant="transparent"
                        size="small"
                        className="text-ui-fg-error"
                        onClick={() => onDelete(value)}
                    >
                        <Trash />
                    </IconButton>
                </div>
            </Table.Cell>
        </Table.Row>
    )
}

export default AttributeDetailPage
