import { Button, Heading, Input, Label, Text, toast, FocusModal, Textarea, Select } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

type CreateAttributeModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export const CreateAttributeModal = ({ open, onOpenChange }: CreateAttributeModalProps) => {
    const [label, setLabel] = useState("")
    const [handle, setHandle] = useState("")
    const [loading, setLoading] = useState(false)
    const queryClient = useQueryClient()

    // New display metadata fields
    const [displayName, setDisplayName] = useState("")
    const [description, setDescription] = useState("")
    const [filterType, setFilterType] = useState("checkbox")
    const [icon, setIcon] = useState("")
    const [unit, setUnit] = useState("")
    const [filterOrder, setFilterOrder] = useState("")

    // Auto-generate handle from label
    useEffect(() => {
        if (!label) {
            setHandle("")
            return
        }
        // Simple slugify: lowercase, replace spaces with dashes, remove special chars
        const slug = label
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^\w-]/g, "")
        setHandle(slug)
    }, [label])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)

        try {
            const res = await fetch("/admin/attributes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    label,
                    handle,
                    display_name: displayName || null,
                    description: description || null,
                    filter_type: filterType || "checkbox",
                    icon: icon || null,
                    unit: unit || null,
                    filter_order: filterOrder ? parseInt(filterOrder) : null
                }),
            })

            if (!res.ok) {
                const errData = await res.json()
                throw new Error(errData.message || "Failed to create attribute")
            }

            const data = await res.json()
            toast.success("Attribute created", {
                description: `Created "${data.attribute.label}"`,
            })

            queryClient.invalidateQueries({ queryKey: ["attributes"] })
            queryClient.invalidateQueries({ queryKey: ["attribute-sets"] }) // might affect counts
            onOpenChange(false)
            // Reset all fields
            setLabel("")
            setHandle("")
            setDisplayName("")
            setDescription("")
            setFilterType("checkbox")
            setIcon("")
            setUnit("")
            setFilterOrder("")
        } catch (err) {
            toast.error("Error", {
                description: (err as Error).message,
            })
        } finally {
            setLoading(false)
        }
    }

    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content>
                <FocusModal.Header>
                    <Button variant="primary" type="submit" form="create-attr-form" isLoading={loading}>
                        Create Attribute
                    </Button>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-16">
                    <div className="flex w-full max-w-lg flex-col gap-y-8">
                        <div className="flex flex-col gap-y-1">
                            <Heading>Create Attribute</Heading>
                            <Text className="text-ui-fg-subtle">
                                Define a new product attribute (e.g. Material, Voltage).
                            </Text>
                        </div>
                        <form id="create-attr-form" onSubmit={handleSubmit} className="flex flex-col gap-y-4">
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="label">Attribute Name</Label>
                                <Input
                                    id="label"
                                    placeholder="e.g. Material"
                                    value={label}
                                    onChange={(e) => setLabel(e.target.value)}
                                    autoFocus
                                    required
                                />
                            </div>
                            <div className="flex flex-col gap-y-2">
                                <Label htmlFor="handle">Handle (ID)</Label>
                                <Input
                                    id="handle"
                                    value={handle}
                                    onChange={(e) => setHandle(e.target.value)}
                                    required
                                    className="font-mono text-ui-fg-subtle"
                                />
                                <Text size="small" className="text-ui-fg-muted">
                                    Unique identifier used in code/API.
                                </Text>
                            </div>

                            {/* Display Configuration Section */}
                            <div className="border-t pt-4 mt-2">
                                <Text weight="plus" size="small" className="mb-3">Display Configuration</Text>

                                <div className="flex flex-col gap-y-4">
                                    <div className="flex flex-col gap-y-2">
                                        <Label htmlFor="display_name">Display Name (Optional)</Label>
                                        <Input
                                            id="display_name"
                                            placeholder="e.g. Color Temperature"
                                            value={displayName}
                                            onChange={(e) => setDisplayName(e.target.value)}
                                        />
                                        <Text size="small" className="text-ui-fg-muted">
                                            Override for frontend display. If empty, uses Attribute Name.
                                        </Text>
                                    </div>

                                    <div className="flex flex-col gap-y-2">
                                        <Label htmlFor="description">Description (Optional)</Label>
                                        <Textarea
                                            id="description"
                                            placeholder="e.g. Select the white color temperature..."
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            rows={2}
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="flex flex-col gap-y-2">
                                            <Label htmlFor="filter_type">Filter Type</Label>
                                            <Select value={filterType} onValueChange={setFilterType}>
                                                <Select.Trigger id="filter_type">
                                                    <Select.Value />
                                                </Select.Trigger>
                                                <Select.Content>
                                                    <Select.Item value="checkbox">Checkbox</Select.Item>
                                                    <Select.Item value="range">Range</Select.Item>
                                                    <Select.Item value="toggle">Toggle</Select.Item>
                                                    <Select.Item value="dropdown">Dropdown</Select.Item>
                                                    <Select.Item value="color-swatch">Color Swatch</Select.Item>
                                                </Select.Content>
                                            </Select>
                                        </div>

                                        <div className="flex flex-col gap-y-2">
                                            <Label htmlFor="filter_order">Order (Optional)</Label>
                                            <Input
                                                id="filter_order"
                                                type="number"
                                                placeholder="1"
                                                value={filterOrder}
                                                onChange={(e) => setFilterOrder(e.target.value)}
                                                min="0"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="flex flex-col gap-y-2">
                                            <Label htmlFor="icon">Icon (Optional)</Label>
                                            <Input
                                                id="icon"
                                                placeholder="thermometer"
                                                value={icon}
                                                onChange={(e) => setIcon(e.target.value)}
                                            />
                                            <Text size="small" className="text-ui-fg-muted">
                                                e.g. thermometer, bolt, ruler
                                            </Text>
                                        </div>

                                        <div className="flex flex-col gap-y-2">
                                            <Label htmlFor="unit">Unit (Optional)</Label>
                                            <Input
                                                id="unit"
                                                placeholder="K"
                                                value={unit}
                                                onChange={(e) => setUnit(e.target.value)}
                                            />
                                            <Text size="small" className="text-ui-fg-muted">
                                                e.g. K, V, W, mm
                                            </Text>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </form>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
