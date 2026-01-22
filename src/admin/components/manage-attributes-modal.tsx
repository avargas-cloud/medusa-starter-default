
import { Button, FocusModal, Heading, Label, Select, Table, toast, Input, IconButton } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query"
import { Trash, Plus, XMark } from "@medusajs/icons"

type AttributeValue = {
    id: string
    value: string
    attribute_key: {
        id: string
        label: string
        handle: string
    }
}

type AttributeKey = {
    id: string
    label: string
    handle: string
    values: { id: string; value: string }[]
}

type ManageAttributesModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    productId: string
    currentAttributes: AttributeValue[]
}

export const ManageAttributesModal = ({
    open,
    onOpenChange,
    productId,
    currentAttributes
}: ManageAttributesModalProps) => {
    const queryClient = useQueryClient()
    // We store the full object for UI display
    const [tempAttributes, setTempAttributes] = useState<AttributeValue[]>([])

    // Fetch all available attributes and keys
    const { data: allKeysData } = useQuery({
        queryKey: ["attribute-keys"],
        queryFn: async () => {
            const res = await fetch("/admin/attributes")
            return res.json()
        }
    })

    const allKeys: AttributeKey[] = allKeysData?.attribute_keys || []

    useEffect(() => {
        if (open) {
            setTempAttributes(currentAttributes)
        }
    }, [open, currentAttributes])

    const updateAttributes = useMutation({
        mutationFn: async (valueIds: string[]) => {
            const res = await fetch(`/admin/products/${productId}/attributes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value_ids: valueIds })
            })
            if (!res.ok) throw new Error("Failed to save attributes")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Attributes saved")
            queryClient.invalidateQueries({ queryKey: ["product-attributes", productId] })
            onOpenChange(false)
        },
        onError: (err) => {
            toast.error("Error saving attributes", { description: err.message })
        }
    })

    // Local state for "Add New" row
    const [newKeyId, setNewKeyId] = useState<string>("")
    const [newValueId, setNewValueId] = useState<string>("")
    const [isCreatingValue, setIsCreatingValue] = useState(false)
    const [newValueStr, setNewValueStr] = useState("")

    const handleAdd = async () => {
        if (!newKeyId) return

        let finalValueId = newValueId
        let finalValueStr = ""
        let finalKey = allKeys.find(k => k.id === newKeyId)

        if (isCreatingValue && newValueStr) {
            // Create value on the fly
            try {
                const res = await fetch(`/admin/attributes/${newKeyId}/values`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ value: newValueStr })
                })
                const data = await res.json()
                if (data.attribute_value) {
                    finalValueId = data.attribute_value.id
                    finalValueStr = data.attribute_value.value
                    // Refresh keys to get new value in list? 
                    queryClient.invalidateQueries({ queryKey: ["attribute-keys"] })
                }
            } catch (e) {
                toast.error("Failed to create value")
                return
            }
        } else if (finalValueId) {
            const val = finalKey?.values.find(v => v.id === finalValueId)
            finalValueStr = val?.value || ""
        }

        if (finalValueId && finalKey) {
            // Check if key already exists in selection (usually 1 val per key is standard, but flexible)
            // For now allow multiple, but typically product has 1 Color. 
            // Logic: Remove existing value for this key if we want strict 1:1, or allow multi.
            // Let's assume standard behavior: Replace previous value for same key if exists?
            // User didn't specify. I will Append.

            const newEntry: AttributeValue = {
                id: finalValueId,
                value: finalValueStr,
                attribute_key: {
                    id: finalKey.id,
                    label: finalKey.label,
                    handle: finalKey.handle
                }
            }

            // Remove existing with same Key ID to enforce single-value per key?
            // "Single Selection" style usually preferred.
            // Allow multiple values per key (Multi-Selection enabled)
            setTempAttributes(prev => [...prev, newEntry])

            // Reset
            setNewKeyId("")
            setNewValueId("")
            setNewValueStr("")
            setIsCreatingValue(false)
        }
    }

    const handleRemove = (id: string) => {
        setTempAttributes(prev => prev.filter(a => a.id !== id))
    }

    const handleSave = () => {
        updateAttributes.mutate(tempAttributes.map(a => a.id))
    }

    const selectedKey = allKeys.find(k => k.id === newKeyId)

    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content>
                <FocusModal.Header>
                    <div className="flex w-full justify-between px-4">
                        <div />
                        <Button onClick={handleSave} isLoading={updateAttributes.isPending}>Save</Button>
                    </div>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-12 px-4 max-w-3xl mx-auto w-full overflow-y-auto">
                    <Heading level="h2" className="mb-6">Manage Attributes</Heading>

                    <div className="w-full flex flex-col gap-4">
                        {/* List Existing */}
                        <div className="border rounded-lg overflow-hidden">
                            <Table>
                                <Table.Header>
                                    <Table.Row>
                                        <Table.HeaderCell>Attribute</Table.HeaderCell>
                                        <Table.HeaderCell>Value</Table.HeaderCell>
                                        <Table.HeaderCell className="text-right">Action</Table.HeaderCell>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {tempAttributes.map(attr => (
                                        <Table.Row key={attr.id}>
                                            <Table.Cell className="text-ui-fg-subtle">{attr.attribute_key?.label}</Table.Cell>
                                            <Table.Cell className="font-medium">{attr.value}</Table.Cell>
                                            <Table.Cell className="text-right">
                                                <IconButton variant="transparent" onClick={() => handleRemove(attr.id)}>
                                                    <Trash className="text-ui-fg-muted hover:text-ui-fg-error" />
                                                </IconButton>
                                            </Table.Cell>
                                        </Table.Row>
                                    ))}
                                    {tempAttributes.length === 0 && (
                                        <Table.Row>
                                            <Table.Cell className="text-center text-ui-fg-muted">
                                                No attributes selected
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </Table.Body>
                            </Table>
                        </div>

                        {/* Add New Section */}
                        <div className="p-4 bg-ui-bg-subtle rounded-lg flex gap-3 items-end border">
                            <div className="flex flex-col gap-2 w-1/3">
                                <Label size="small">Attribute Key</Label>
                                <Select value={newKeyId} onValueChange={setNewKeyId}>
                                    <Select.Trigger>
                                        <Select.Value placeholder="Select Attribute" />
                                    </Select.Trigger>
                                    <Select.Content>
                                        {allKeys.map(k => (
                                            <Select.Item key={k.id} value={k.id}>{k.label}</Select.Item>
                                        ))}
                                    </Select.Content>
                                </Select>
                            </div>

                            <div className="flex flex-col gap-2 w-1/3">
                                <Label size="small">Value</Label>
                                {isCreatingValue ? (
                                    <div className="flex gap-1">
                                        <Input
                                            placeholder="New Value..."
                                            value={newValueStr}
                                            onChange={(e) => setNewValueStr(e.target.value)}
                                            autoFocus
                                        />
                                        <IconButton size="small" onClick={() => setIsCreatingValue(false)}>
                                            <XMark />
                                        </IconButton>
                                    </div>
                                ) : (
                                    <Select
                                        value={newValueId}
                                        onValueChange={(val) => {
                                            if (val === "CREATE_NEW") {
                                                setIsCreatingValue(true)
                                                setNewValueId("")
                                            } else {
                                                setNewValueId(val)
                                            }
                                        }}
                                        disabled={!newKeyId}
                                    >
                                        <Select.Trigger>
                                            <Select.Value placeholder="Select Value" />
                                        </Select.Trigger>
                                        <Select.Content>
                                            {selectedKey?.values?.map(v => (
                                                <Select.Item key={v.id} value={v.id}>{v.value}</Select.Item>
                                            ))}
                                            <Select.Separator />
                                            <Select.Item value="CREATE_NEW">
                                                <span className="text-ui-fg-interactive">+ Create New</span>
                                            </Select.Item>
                                        </Select.Content>
                                    </Select>
                                )}
                            </div>

                            <Button
                                variant="secondary"
                                onClick={handleAdd}
                                disabled={!newKeyId || (!newValueId && !newValueStr)}
                            >
                                <Plus /> Add
                            </Button>
                        </div>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
