import { Button, FocusModal, Heading, Label, Select, Table, toast, Switch, Text, Badge } from "@medusajs/ui"
import { useState, useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus, XMark } from "@medusajs/icons"

// Import modular utilities and hooks
import { groupAttributesByKey, getKeyAvailability } from "./attribute-management/utils/groupAttributes"
import { shouldShowVariantToggle } from "./attribute-management/utils/validateVariants"
import { useConfirmation } from "./attribute-management/hooks/useConfirmation"
import { useAttributeActions } from "./attribute-management/hooks/useAttributeActions"
import { ConfirmationDialog } from "./attribute-management/components/ConfirmationDialog"

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

export const ManageAttributesModal = ({
    open,
    onOpenChange,
    currentAttributes,
    initialVariantKeys,
    onSaveAtomic
}: Omit<ManageAttributesModalProps, 'productId'>) => {
    // State
    const [tempAttributes, setTempAttributes] = useState<AttributeValue[]>([])
    const [variantFlags, setVariantFlags] = useState<Record<string, boolean>>({})
    const [isSaving, setIsSaving] = useState(false)
    const [newKeyId, setNewKeyId] = useState<string>("")
    const [newValueId, setNewValueId] = useState<string>("")

    // Fetch all attribute keys
    const { data: allKeysData } = useQuery({
        queryKey: ["attribute-keys"],
        queryFn: async () => {
            const res = await fetch("/admin/attributes")
            return res.json()
        }
    })
    const allKeys: AttributeKey[] = allKeysData?.attribute_keys || []

    // Initialize state when modal opens
    useEffect(() => {
        if (open) {
            setTempAttributes(currentAttributes)

            const initialFlags: Record<string, boolean> = {}
            if (initialVariantKeys) {
                initialVariantKeys.forEach(k => initialFlags[k] = true)
            }
            setVariantFlags(initialFlags)
        }
    }, [open, currentAttributes, initialVariantKeys])

    // Use extracted hooks
    const { handleSaveWithConfirmation, confirmationState, closeConfirmation } = useConfirmation(initialVariantKeys, allKeys)
    const { addAttribute, removeAttribute, toggleVariant } = useAttributeActions(
        tempAttributes,
        setTempAttributes,
        variantFlags,
        setVariantFlags
    )

    // Group attributes for display
    const groupedAttributes = useMemo(() => {
        return groupAttributesByKey(tempAttributes)
    }, [tempAttributes])

    // Handle save with confirmation
    const handleSave = async () => {
        const proceedWithSave = async () => {
            setIsSaving(true)
            try {
                await onSaveAtomic(tempAttributes, variantFlags)
                toast.success("Attributes saved successfully")
                onOpenChange(false)
            } catch (error) {
                console.error("Save failed:", error)
                toast.error("Failed to save attributes")
            } finally {
                setIsSaving(false)
            }
        }

        await handleSaveWithConfirmation(variantFlags, proceedWithSave)
    }

    // Handle add new attribute
    const handleAddNew = () => {
        if (!newKeyId || !newValueId) return

        const key = allKeys.find(k => k.id === newKeyId)
        const value = key?.values.find(v => v.id === newValueId)

        if (!key || !value) return

        const newAttr: AttributeValue = {
            id: value.id,
            value: value.value,
            attribute_key: {
                id: key.id,
                label: key.label,
                handle: key.handle
            }
        }

        addAttribute(newAttr)
        setNewKeyId("")
        setNewValueId("")
    }

    // Get available values for selected key
    const availableValuesForNewKey = useMemo(() => {
        if (!newKeyId) return []

        const key = allKeys.find(k => k.id === newKeyId)
        if (!key) return []

        const usedIds = tempAttributes
            .filter(a => a.attribute_key.id === newKeyId)
            .map(a => a.id)

        return key.values.filter(v => !usedIds.includes(v.id))
    }, [newKeyId, allKeys, tempAttributes])

    // Get unused keys for "Add New" dropdown
    const unusedKeys = useMemo(() => {
        const usedKeyIds = new Set(tempAttributes.map(a => a.attribute_key.id))
        return allKeys.filter(k => {
            if (usedKeyIds.has(k.id)) {
                // Check if this key has more available values
                const availability = getKeyAvailability(k, tempAttributes)
                return availability.hasMore
            }
            return true
        })
    }, [allKeys, tempAttributes])

    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content className="max-w-[66vw] mx-auto">
                <FocusModal.Header>
                    <div className="flex items-center justify-between gap-4">
                        <Heading>Manage Product Attributes</Heading>
                        <Button onClick={handleSave} isLoading={isSaving}>
                            Save
                        </Button>
                    </div>
                </FocusModal.Header>

                <FocusModal.Body className="overflow-y-auto max-h-[calc(100vh-200px)] px-6 py-4">
                    <div className="flex flex-col gap-4">
                        {/* Add New Attribute Section */}
                        <div className="flex gap-2 items-end border-b pb-4">
                            <div className="flex-1">
                                <Label>Attribute</Label>
                                <Select
                                    value={newKeyId}
                                    onValueChange={setNewKeyId}
                                >
                                    <Select.Trigger>
                                        <Select.Value placeholder="Select attribute..." />
                                    </Select.Trigger>
                                    <Select.Content>
                                        {unusedKeys.map(key => (
                                            <Select.Item key={key.id} value={key.id}>
                                                {key.label}
                                            </Select.Item>
                                        ))}
                                    </Select.Content>
                                </Select>
                            </div>

                            <div className="flex-1">
                                <Label>Value</Label>
                                <Select
                                    value={newValueId}
                                    onValueChange={setNewValueId}
                                    disabled={!newKeyId}
                                >
                                    <Select.Trigger>
                                        <Select.Value placeholder="Select value..." />
                                    </Select.Trigger>
                                    <Select.Content>
                                        {availableValuesForNewKey.map(val => (
                                            <Select.Item key={val.id} value={val.id}>
                                                {val.value}
                                            </Select.Item>
                                        ))}
                                    </Select.Content>
                                </Select>
                            </div>

                            <Button
                                onClick={handleAddNew}
                                disabled={!newKeyId || !newValueId}
                                variant="secondary"
                            >
                                <Plus /> Add
                            </Button>
                        </div>

                        {/* Attributes Table */}
                        <div>
                            <Table>
                                <Table.Header>
                                    <Table.Row>
                                        <Table.HeaderCell>Attribute</Table.HeaderCell>
                                        <Table.HeaderCell>Values</Table.HeaderCell>
                                        <Table.HeaderCell>Variant?</Table.HeaderCell>
                                        <Table.HeaderCell></Table.HeaderCell>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {groupedAttributes.map((group: any) => {
                                        const keyId = group.key_id
                                        const showToggle = shouldShowVariantToggle(keyId, tempAttributes)
                                        const isVariant = variantFlags[keyId] || false

                                        return (
                                            <Table.Row key={keyId}>
                                                <Table.Cell>
                                                    <div className="flex items-center gap-2">
                                                        <Text weight="plus">{group.key_title}</Text>
                                                        {isVariant && (
                                                            <Badge color="purple" size="small">
                                                                Variant
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <div className="flex gap-1 flex-wrap">
                                                        {group.values.map((val: any) => (
                                                            <div
                                                                key={val.id}
                                                                className="inline-flex items-center gap-1 px-2 py-1 bg-ui-bg-subtle rounded-md text-sm"
                                                            >
                                                                <span>{val.value}</span>
                                                                <button
                                                                    onClick={() => removeAttribute(val.id)}
                                                                    className="hover:bg-ui-bg-subtle-hover rounded p-0.5 transition-colors"
                                                                    type="button"
                                                                >
                                                                    <XMark className="w-3 h-3" />
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    {showToggle ? (
                                                        <div className="flex items-center">
                                                            <Switch
                                                                checked={isVariant}
                                                                onCheckedChange={(checked) => {
                                                                    toggleVariant(keyId, checked)
                                                                }}
                                                                className="scale-150"
                                                            />
                                                        </div>
                                                    ) : (
                                                        <Text size="small" className="text-ui-fg-muted">
                                                            Need 2+ values
                                                        </Text>
                                                    )}
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <span className="text-ui-fg-muted">
                                                        {group.values.length} value(s)
                                                    </span>
                                                </Table.Cell>
                                            </Table.Row>
                                        )
                                    })}
                                </Table.Body>
                            </Table>
                        </div>
                    </div>
                </FocusModal.Body>
            </FocusModal.Content>

            {/* Confirmation Dialog */}
            {confirmationState.onConfirm && (
                <ConfirmationDialog
                    open={confirmationState.isOpen}
                    onOpenChange={closeConfirmation}
                    title={confirmationState.title}
                    description={confirmationState.description}
                    onConfirm={confirmationState.onConfirm}
                />
            )}
        </FocusModal>
    )
}
