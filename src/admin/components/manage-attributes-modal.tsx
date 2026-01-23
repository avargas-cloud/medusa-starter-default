
import { Button, FocusModal, Heading, Label, Select, Table, toast, Input, IconButton, Switch, Text, Badge, DropdownMenu, Popover, clx } from "@medusajs/ui"
import { useState, useEffect, useMemo } from "react"
import { useQueryClient, useQuery } from "@tanstack/react-query"
import { Trash, Plus, XMark, ChevronDown, Check } from "@medusajs/icons"

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
    options?: string[]
}

type ManageAttributesModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    productId: string
    currentAttributes: AttributeValue[]
    initialVariantKeys: string[]
    onSaveAtomic: (selectedAttributes: any[], variantFlags: Record<string, boolean>) => Promise<void>
}

// Helper to group for the Modal UI too
const groupAttrs = (flatAttributes: any[]) => {
    const groups: Record<string, any> = {};
    flatAttributes.forEach(attr => {
        const keyId = attr.attribute_key.id;
        if (!groups[keyId]) {
            groups[keyId] = {
                key_id: keyId,
                key_title: attr.attribute_key.label || attr.attribute_key.title,
                key: attr.attribute_key, // full obj
                values: []
            };
        }
        groups[keyId].values.push({
            id: attr.id,
            value: attr.value
        });
    });
    return Object.values(groups);
}

// Local utility for accessibility
const VisuallyHidden = ({ children }: { children: React.ReactNode }) => <span className="sr-only">{children}</span>

// Helper to check if a key has remaining options
const getKeyStatus = (key: AttributeKey | undefined, usedValues: AttributeValue[]) => {
    if (!key) return { hasMore: false }

    const usedCount = usedValues.filter(v => v.attribute_key.id === key.id).length


    // Total available = entities + (options that aren't yet entities)
    // Actually simpler: if used count < (unique values in entities + unique options), there's more.
    // Heuristic: If there are options defined, assume there might be more unless we used them all.
    // For now, let's just sum specific values + distinct options.

    const distinctOptions = new Set([
        ...(key.values?.map(v => v.value) || []),
        ...(key.options || [])
    ])

    return { hasMore: distinctOptions.size > usedCount }
}

export const ManageAttributesModal = ({
    open,
    onOpenChange,
    // productId, // Unused but kept in props for interface consistency logic
    currentAttributes,
    initialVariantKeys,
    onSaveAtomic
}: ManageAttributesModalProps) => {
    const queryClient = useQueryClient()

    // State: Selected Attributes (Flat List)
    const [tempAttributes, setTempAttributes] = useState<AttributeValue[]>([])

    // State: Variant Flags (Map KeyId -> Boolean)
    const [variantFlags, setVariantFlags] = useState<Record<string, boolean>>({})

    // Fetch all available keys
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

            // Initialize flags from props
            const initialFlags: Record<string, boolean> = {}
            if (initialVariantKeys) {
                initialVariantKeys.forEach(k => initialFlags[k] = true)
            }
            setVariantFlags(initialFlags)
        }
    }, [open, currentAttributes, initialVariantKeys])

    const [isSaving, setIsSaving] = useState(false)

    // Local state for "Add New"
    const [newKeyId, setNewKeyId] = useState<string>("")
    const [newValueId, setNewValueId] = useState<string>("")
    const [isCreatingValue, setIsCreatingValue] = useState(false)
    const [newValueStr, setNewValueStr] = useState("")

    // Searchable Select State
    const [keySearchQuery, setKeySearchQuery] = useState("")
    const [isKeySelectOpen, setIsKeySelectOpen] = useState(false)

    const handleAdd = async () => {
        if (!newKeyId) return

        let finalValueId = newValueId
        let finalValueStr = ""
        let finalKey = allKeys.find(k => k.id === newKeyId)

        if (isCreatingValue && newValueStr) {
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
                    queryClient.invalidateQueries({ queryKey: ["attribute-keys"] })
                }
            } catch (e) {
                toast.error("Failed to create value")
                return
            }
        } else if (finalValueId) {
            // Check if it's a raw OPTION selection
            if (finalValueId.startsWith("OPTION:")) {
                const rawVal = finalValueId.replace("OPTION:", "")
                // Create it on the fly
                try {
                    const res = await fetch(`/admin/attributes/${newKeyId}/values`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ value: rawVal })
                    })
                    const data = await res.json()
                    if (data.attribute_value) {
                        finalValueId = data.attribute_value.id
                        finalValueStr = data.attribute_value.value
                        queryClient.invalidateQueries({ queryKey: ["attribute-keys"] })
                    } else {
                        throw new Error("No value returned")
                    }
                } catch (e) {
                    toast.error(`Failed to create value "${rawVal}"`)
                    return
                }
            } else {
                // Existing entity
                const val = finalKey?.values.find(v => v.id === finalValueId)
                finalValueStr = val?.value || ""
            }
        }

        if (finalValueId && finalKey) {
            const newEntry: AttributeValue = {
                id: finalValueId,
                value: finalValueStr,
                attribute_key: {
                    id: finalKey.id,
                    label: finalKey.label,
                    handle: finalKey.handle
                }
            }
            setTempAttributes(prev => [...prev, newEntry])

            // Reset inputs
            setNewKeyId("")
            setNewValueId("")
            setNewValueStr("")
            setIsCreatingValue(false)
        }
    }

    const handleRemoveValue = (id: string) => {
        setTempAttributes(prev => prev.filter(a => a.id !== id))
    }

    const handleRemoveGroup = (keyId: string) => {
        setTempAttributes(prev => prev.filter(a => a.attribute_key.id !== keyId))
        // Optionally unset variant flag? No, keep it preferred.
    }

    const toggleVariant = (keyId: string) => {
        setVariantFlags(prev => ({
            ...prev,
            [keyId]: !prev[keyId]
        }))
    }



    const confirmSave = async () => {
        setIsSaving(true)
        try {
            await onSaveAtomic(tempAttributes, variantFlags)
            toast.success("Attributes saved successfully")
        } catch (e) {
            toast.error("Failed to save")
        } finally {
            setIsSaving(false)
        }
    }

    const selectedKey = allKeys.find(k => k.id === newKeyId)
    const groupedDisplay = groupAttrs(tempAttributes)

    // Calculate Available Keys (FILTERING LOGIC)
    // We filter keys that are NOT present in the tempAttributes list at all?
    // OR we filter keys that have NO remaining values?
    // Plan says: "Hide keys from the Add dropdown if they are already in the list."
    // But we need to allow "Inline Add" which re-selects it.
    // Refined Logic: Dropdown shows unused keys. Specific key is forced when clicking Inline Add.

    const usedKeyIds = new Set(tempAttributes.map(a => a.attribute_key.id))
    // If newKeyId is set (manually or via quick add), we MUST include it even if used
    const availableKeys = allKeys.filter(k => !usedKeyIds.has(k.id) || k.id === newKeyId)

    const filteredKeys = useMemo(() => {
        if (!keySearchQuery) return availableKeys
        return availableKeys.filter(k => k.label.toLowerCase().includes(keySearchQuery.toLowerCase()))
    }, [availableKeys, keySearchQuery])

    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content>
                {/* Visual Title is inside Body, but Radix needs an Accessible Title in the Content context */}
                <VisuallyHidden>
                    <FocusModal.Title>Manage Attributes</FocusModal.Title>
                    <FocusModal.Description>
                        Interface to add, edit, or remove attributes and variant settings for this product.
                    </FocusModal.Description>
                </VisuallyHidden>

                <FocusModal.Header>
                    <div className="flex w-full justify-between px-4">
                        <div />
                        <Button onClick={confirmSave} isLoading={isSaving}>Save</Button>
                    </div>
                </FocusModal.Header>
                <FocusModal.Body className="flex flex-col items-center py-12 px-4 max-w-3xl mx-auto w-full overflow-y-auto">
                    <Heading level="h2" className="mb-6">Manage Attributes</Heading>

                    <div className="w-full flex flex-col gap-8">

                        {/* 1. Add New Section (Moved to TOP) */}
                        <div className="p-4 bg-ui-bg-subtle rounded-lg flex gap-3 items-end border">
                            <div className="flex flex-col gap-2 w-1/3">
                                <Label size="small">Attribute Key</Label>
                                <Popover open={isKeySelectOpen} onOpenChange={setIsKeySelectOpen}>
                                    <Popover.Trigger asChild>
                                        <Button
                                            variant="secondary"
                                            className="w-full justify-between"
                                            id="add-attribute-select"
                                        >
                                            {selectedKey ? selectedKey.label : "Select Attribute"}
                                            <ChevronDown className="text-ui-fg-muted" />
                                        </Button>
                                    </Popover.Trigger>
                                    <Popover.Content className="p-0 w-[300px] overflow-hidden">
                                        <div className="p-2 border-b">
                                            <Input
                                                placeholder="Search attributes..."
                                                value={keySearchQuery}
                                                onChange={(e) => setKeySearchQuery(e.target.value)}
                                                autoFocus
                                                className="border-none shadow-none focus-visible:ring-0"
                                            />
                                        </div>
                                        <div className="max-h-[200px] overflow-y-auto p-1">
                                            {filteredKeys.map(k => (
                                                <div
                                                    key={k.id}
                                                    className={clx(
                                                        "flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer hover:bg-ui-bg-base-hover text-small",
                                                        newKeyId === k.id && "bg-ui-bg-base-pressed"
                                                    )}
                                                    onClick={() => {
                                                        setNewKeyId(k.id)
                                                        setIsKeySelectOpen(false)
                                                        setKeySearchQuery("")
                                                    }}
                                                >
                                                    {k.label}
                                                    {newKeyId === k.id && <Check className="text-ui-fg-interactive" />}
                                                </div>
                                            ))}
                                            {filteredKeys.length === 0 && (
                                                <div className="px-2 py-2 text-ui-fg-muted text-small text-center">
                                                    No results found
                                                </div>
                                            )}
                                        </div>
                                    </Popover.Content>
                                </Popover>
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
                                            {(() => {
                                                const existingEntityValues = selectedKey?.values || []
                                                const existingEntityValueStrings = new Set(existingEntityValues.map(v => v.value))

                                                // Filter out already selected values for this key
                                                const filteredEntities = existingEntityValues.filter(v => !tempAttributes.some(attr => attr.id === v.id))

                                                // Filter options:
                                                // 1. Must not match an existing entity's value (mapped above)
                                                // 2. Must not be currently selected (as a temp attribute)
                                                const availableOptions = (selectedKey?.options || [])
                                                    .filter(opt => !existingEntityValueStrings.has(opt))
                                                    .filter(opt => !tempAttributes.some(a => a.value === opt && a.attribute_key.id === selectedKey?.id))

                                                return (
                                                    <>
                                                        {filteredEntities.map((v: any) => (
                                                            <Select.Item key={v.id} value={v.id}>{v.value}</Select.Item>
                                                        ))}
                                                        {availableOptions.map((opt: string) => (
                                                            <Select.Item key={`opt-${opt}`} value={`OPTION:${opt}`}>{opt}</Select.Item>
                                                        ))}
                                                    </>
                                                )
                                            })()}
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

                        <div className="w-full border-b border-ui-border-base" />

                        {/* 2. List Existing (Moved to BOTTOM) */}
                        <div className="border rounded-lg overflow-hidden">
                            <Table>
                                <Table.Header>
                                    <Table.Row>
                                        <Table.HeaderCell>Attribute</Table.HeaderCell>
                                        <Table.HeaderCell>Values</Table.HeaderCell>
                                        <Table.HeaderCell>Use as Variant</Table.HeaderCell>
                                        <Table.HeaderCell className="text-right">Action</Table.HeaderCell>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {groupedDisplay.map((group: any) => {
                                        // Check if this group has more available values
                                        const { hasMore } = getKeyStatus(
                                            allKeys.find(k => k.id === group.key_id) || group.key,
                                            tempAttributes
                                        )

                                        return (
                                            <Table.Row key={group.key_id}>
                                                <Table.Cell>
                                                    <div className="flex items-center gap-2">
                                                        <Text weight="plus">{group.key_title}</Text>
                                                    </div>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <div className="flex gap-2 flex-wrap items-center">
                                                        {group.values.map((val: any) => (
                                                            <div key={val.id} className="relative group">
                                                                <Badge>{val.value}</Badge>
                                                                <div
                                                                    className="absolute -top-2 -right-2 hidden group-hover:flex bg-ui-bg-base rounded-full shadow cursor-pointer p-0.5"
                                                                    onClick={() => handleRemoveValue(val.id)}
                                                                >
                                                                    <XMark className="w-3 h-3 text-ui-fg-error" />
                                                                </div>
                                                            </div>
                                                        ))}
                                                        {hasMore && (
                                                            <DropdownMenu>
                                                                <DropdownMenu.Trigger asChild>
                                                                    <IconButton
                                                                        size="small"
                                                                        variant="transparent"
                                                                        className="text-ui-fg-interactive hover:bg-ui-bg-base-hover"
                                                                    >
                                                                        <Plus />
                                                                    </IconButton>
                                                                </DropdownMenu.Trigger>
                                                                <DropdownMenu.Content>
                                                                    {(() => {
                                                                        const keyData = allKeys.find(k => k.id === group.key_id) || group.key
                                                                        const usedValueIds = tempAttributes.filter(a => a.attribute_key.id === group.key_id).map(a => a.id)
                                                                        // 1. Existing Real Values
                                                                        const availableValues = keyData?.values?.filter((v: any) => !usedValueIds.includes(v.id)) || []

                                                                        // 2. Options (Strings) that don't have a Value entity yet
                                                                        // We filter out options that match the string value of any EXISTING available value or USED value
                                                                        const existingValueStrings = new Set([
                                                                            ...(keyData?.values?.map((v: any) => v.value) || []),
                                                                            ...tempAttributes.filter(a => a.attribute_key.id === group.key_id).map(a => a.value)
                                                                        ])

                                                                        const availableOptions = (keyData?.options || [])
                                                                            .filter((opt: string) => !existingValueStrings.has(opt))

                                                                        return (
                                                                            <>
                                                                                {availableValues.map((v: any) => (
                                                                                    <DropdownMenu.Item
                                                                                        key={v.id}
                                                                                        onClick={() => {
                                                                                            const newEntry = {
                                                                                                id: v.id,
                                                                                                value: v.value,
                                                                                                attribute_key: {
                                                                                                    id: keyData.id,
                                                                                                    label: keyData.label,
                                                                                                    handle: keyData.handle
                                                                                                }
                                                                                            }
                                                                                            setTempAttributes(prev => [...prev, newEntry])
                                                                                        }}
                                                                                    >
                                                                                        {v.value}
                                                                                    </DropdownMenu.Item>
                                                                                ))}
                                                                                {availableOptions.map((opt: string) => (
                                                                                    <DropdownMenu.Item
                                                                                        key={`opt-${opt}`}
                                                                                        onClick={async () => {
                                                                                            // Create on the fly
                                                                                            try {
                                                                                                const res = await fetch(`/admin/attributes/${keyData.id}/values`, {
                                                                                                    method: "POST",
                                                                                                    headers: { "Content-Type": "application/json" },
                                                                                                    body: JSON.stringify({ value: opt })
                                                                                                })
                                                                                                const data = await res.json()
                                                                                                if (data.attribute_value) {
                                                                                                    const newEntry = {
                                                                                                        id: data.attribute_value.id,
                                                                                                        value: data.attribute_value.value,
                                                                                                        attribute_key: {
                                                                                                            id: keyData.id,
                                                                                                            label: keyData.label,
                                                                                                            handle: keyData.handle
                                                                                                        }
                                                                                                    }
                                                                                                    setTempAttributes(prev => [...prev, newEntry])
                                                                                                    queryClient.invalidateQueries({ queryKey: ["attribute-keys"] })
                                                                                                }
                                                                                            } catch (e) {
                                                                                                toast.error(`Failed to create value "${opt}"`)
                                                                                            }
                                                                                        }}
                                                                                    >
                                                                                        {opt}
                                                                                    </DropdownMenu.Item>
                                                                                ))}
                                                                            </>
                                                                        )
                                                                    })()}
                                                                </DropdownMenu.Content>
                                                            </DropdownMenu>
                                                        )}
                                                    </div>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <div className="flex items-center gap-2">
                                                        <Switch
                                                            checked={!!variantFlags[group.key_id]}
                                                            onCheckedChange={() => toggleVariant(group.key_id)}
                                                        />
                                                        <Label>{variantFlags[group.key_id] ? "Yes" : "No"}</Label>
                                                    </div>
                                                </Table.Cell>
                                                <Table.Cell className="text-right">
                                                    <IconButton variant="transparent" onClick={() => handleRemoveGroup(group.key_id)}>
                                                        <Trash className="text-ui-fg-muted hover:text-ui-fg-error" />
                                                    </IconButton>
                                                </Table.Cell>
                                            </Table.Row>
                                        )
                                    })}
                                    {groupedDisplay.length === 0 && (
                                        <Table.Row>
                                            {/* @ts-expect-error colSpan valid in DOM but missing in Table.Cell types */}
                                            <Table.Cell colSpan={4} className="text-center text-ui-fg-muted py-8">
                                                No attributes added. Add one above.
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </Table.Body>
                            </Table>
                        </div>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>
        </FocusModal>
    )
}
