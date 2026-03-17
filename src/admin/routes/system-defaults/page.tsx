import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CogSixTooth } from "@medusajs/icons"
import {
    Container, Heading, Button, Input, Label, Text, toast, Badge, Textarea
} from "@medusajs/ui"
import { useState, useEffect, useCallback, useRef } from "react"

// ── Types ──────────────────────────────────────────────────────────────────────
// data_scope is stored as comma-separated: "customers" | "orders" | "customers,orders"
// Future doc types can be added (e.g. "invoices", "vendors")
const ALL_DOC_SCOPES = [
    { key: "customers", label: "Customers" },
    { key: "orders",    label: "Orders"    },
] as const
type DocScopeKey = typeof ALL_DOC_SCOPES[number]["key"]  // "customers" | "orders"

type DataScope = string  // comma-separated DocScopeKeys, e.g. "customers,orders"

interface SystemDefault {
    id: string
    context: string
    field_name: string
    value: string
    data_scope: DataScope
    sort_order: number
    created_at: string
    updated_at: string
}

const KNOWN_CONTEXTS = ["Document Defaults", "Templates Footer", "Metadata Options"]

const KNOWN_FIELDS_BY_CONTEXT: Record<string, string[]> = {
    "Document Defaults": ["Payment Terms", "Tax Code", "Price List", "Order Status", "Order Type", "Lead Time", "FOB", "Ship Via", "Project Phase"],
    "Templates Footer": ["Draft Order (Estimates)", "Order (Sales Order)", "Invoice"],
    "Metadata Options": ["referential_deposit"],
}

// Default applies_to scopes per known field (comma-separated)
const FIELD_DEFAULT_SCOPE: Record<string, string> = {
    "Payment Terms":           "customers,orders",
    "Price List":              "customers",
    "Order Status":            "customers,orders",
    "Tax Code":                "orders",
    "Order Type":              "orders",
    "Lead Time":               "customers,orders",
    "FOB":                     "orders",
    "Ship Via":                "orders",
    "Project Phase":           "orders",
    "Draft Order (Estimates)": "orders",
    "Order (Sales Order)":     "orders",
    "Invoice":                 "orders",
    "referential_deposit":     "orders",
}

const SCOPE_BADGE_COLOR: Record<DocScopeKey, "blue" | "green"> = {
    customers: "green",
    orders:    "blue",
}

const CONTEXT_COLORS: Record<string, "blue" | "green" | "orange" | "purple" | "grey"> = {
    "Document Defaults": "blue",
    "Templates Footer":  "purple",
    "Metadata Options":  "orange",
}

// ── Modal ──────────────────────────────────────────────────────────────────────
function DefaultModal({
    item,
    onClose,
    onSave,
}: {
    item: Partial<SystemDefault> | null
    onClose: () => void
    onSave: (data: Partial<SystemDefault>) => Promise<void>
}) {
    const [context, setContext] = useState<string>(item?.context ?? KNOWN_CONTEXTS[0] ?? "Document Defaults")
    const [customContext, setCustomContext] = useState("")

    const availableFields = (KNOWN_FIELDS_BY_CONTEXT as Record<string, string[]>)[context] || []
    const initialField: string = item?.field_name || (availableFields.length > 0 ? availableFields[0] ?? "" : "")

    const [field, setField] = useState<string>(initialField)
    const [customField, setCustomField] = useState("")
    const [value, setValue] = useState<string>(item?.value ?? "")
    const [sortOrder, setSortOrder] = useState(item?.sort_order?.toString() ?? "0")
    const [dataScope, setDataScope] = useState<string>(item?.data_scope ?? (initialField ? FIELD_DEFAULT_SCOPE[initialField] : undefined) ?? "customers,orders")
    const [saving, setSaving] = useState(false)

    // Auto-infer context from field
    useEffect(() => {
        if (field && field !== "__custom__") {
            const contextForField = KNOWN_CONTEXTS.find(c => (KNOWN_FIELDS_BY_CONTEXT as Record<string, string[]>)[c]?.includes(field))
            if (contextForField) setContext(contextForField)
            // Auto-set the default data_scope for the chosen known field
            const defaultScope = (FIELD_DEFAULT_SCOPE as Record<string, string>)[field]
            if (defaultScope) setDataScope(defaultScope)
        }
    }, [field])

    const allKnownFields = Object.values(KNOWN_FIELDS_BY_CONTEXT).flat()
    const isCustomField = field === "__custom__" || !allKnownFields.includes(field)
    const isCustomContext = !KNOWN_CONTEXTS.some(c => c === context) && context !== "__custom__"

    const handleSave = async () => {
        const c = context === "__custom__" ? customContext.trim() : context
        const f = field === "__custom__" ? customField.trim() : field
        const v = field === "referential_deposit" ? "auto-injected" : value.trim()
        const order = parseInt(sortOrder, 10) || 0

        if (!c || !f || !v) {
            toast.error("Context, Field, and Value are required")
            return
        }
        setSaving(true)
        try {
            await onSave({ context: c, field_name: f, value: v, sort_order: order, data_scope: dataScope })
            onClose()
        } catch {
            toast.error("Failed to save")
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-[500px] max-h-[90vh] flex flex-col overflow-hidden">
                <div className="px-6 py-4 border-b border-ui-border-base flex items-center justify-between">
                    <Heading level="h2">{item?.id ? "Edit System Default" : "New System Default"}</Heading>
                    <button onClick={onClose} className="text-ui-fg-muted hover:text-ui-fg-base text-xl leading-none">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

                    {/* Field */}
                    <div>
                        <Label className="mb-1 block text-sm">Field Name</Label>
                        <select
                            value={field && allKnownFields.includes(field) ? field : "__custom__"}
                            onChange={e => {
                                setField(e.target.value)
                                if (e.target.value !== "__custom__") setCustomField("")
                            }}
                            className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base"
                        >
                            <optgroup label="Document Defaults" className="bg-ui-bg-base text-ui-fg-base font-semibold">
                                {(KNOWN_FIELDS_BY_CONTEXT["Document Defaults"] ?? []).map(f => (
                                    <option key={f} value={f} className="bg-ui-bg-base text-ui-fg-base font-normal">{f}</option>
                                ))}
                            </optgroup>
                            <optgroup label="Templates Footer" className="bg-ui-bg-base text-ui-fg-base font-semibold">
                                {(KNOWN_FIELDS_BY_CONTEXT["Templates Footer"] ?? []).map(f => (
                                    <option key={f} value={f} className="bg-ui-bg-base text-ui-fg-base font-normal">{f}</option>
                                ))}
                            </optgroup>
                            <optgroup label="Metadata Options" className="bg-ui-bg-base text-ui-fg-base font-semibold">
                                {(KNOWN_FIELDS_BY_CONTEXT["Metadata Options"] ?? []).map(f => (
                                    <option key={f} value={f} className="bg-ui-bg-base text-ui-fg-base font-normal">{f}</option>
                                ))}
                            </optgroup>
                            <option value="__custom__" className="bg-ui-bg-base text-ui-fg-base">Custom field…</option>
                        </select>
                        {isCustomField && (
                            <Input
                                className="mt-3"
                                placeholder="Custom field name (e.g. Shipping Method)"
                                value={field === "__custom__" ? customField : field}
                                onChange={e => field === "__custom__" ? setCustomField(e.target.value) : setField(e.target.value)}
                            />
                        )}
                        {isCustomField && (
                            <div className="mt-3">
                                <Label className="mb-1 block text-sm">Target Context Area</Label>
                                <select
                                    value={context}
                                    onChange={e => setContext(e.target.value)}
                                    className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base"
                                >
                                    <option value="Document Defaults">Document Defaults</option>
                                    <option value="Templates Footer">Templates Footer</option>
                                    <option value="Metadata Options">Metadata Options</option>
                                    <option value="__custom__">Custom Context...</option>
                                </select>
                            </div>
                        )}
                        {isCustomField && isCustomContext && (
                            <Input
                                className="mt-2"
                                placeholder="Custom context name (e.g. Invoice Defaults)"
                                value={context === "__custom__" ? customContext : context}
                                onChange={e => context === "__custom__" ? setCustomContext(e.target.value) : setContext(e.target.value)}
                            />
                        )}
                    </div>

                    {/* Applies To (Data Scope) — only for brand-new entries from the main Add Default button */}
                    {!item?.field_name && (
                        <div>
                            <Label className="mb-1 block text-sm">Applies To</Label>
                            <div className="flex flex-col gap-2 mt-1">
                                {ALL_DOC_SCOPES.map(({ key, label }) => {
                                    const scopes = dataScope.split(",").map(s => s.trim()).filter(Boolean)
                                    const checked = scopes.includes(key)
                                    return (
                                        <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4 cursor-pointer"
                                                checked={checked}
                                                onChange={e => {
                                                    const current = dataScope.split(",").map(s => s.trim()).filter(Boolean)
                                                    const next = e.target.checked
                                                        ? [...new Set([...current, key])]
                                                        : current.filter(s => s !== key)
                                                    if (next.length === 0) return
                                                    setDataScope(next.sort().join(","))
                                                }}
                                            />
                                            <span className="text-sm text-ui-fg-base">{label}</span>
                                        </label>
                                    )
                                })}
                            </div>
                            <Text className="text-xs text-ui-fg-muted mt-1">At least one is required. Use ✏ on existing groups to change scope.</Text>
                        </div>
                    )}

                    <div>
                        <Label className="mb-1 block text-sm">Value</Label>
                        {context === "Templates Footer" ? (
                            <Textarea
                                placeholder="Paste the footer content here. Line breaks are preserved."
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                rows={8}
                                className="font-mono text-xs"
                            />
                        ) : field === "referential_deposit" ? (
                            <Input
                                placeholder="Auto-populated by deposits"
                                value="auto-injected"
                                disabled={true}
                            />
                        ) : (
                            <Input
                                placeholder="e.g. Net-30, Standard Order, 5-7 Days..."
                                value={value}
                                onChange={e => setValue(e.target.value)}
                            />
                        )}
                    </div>

                    {/* Sort Order */}
                    <div>
                        <Label className="mb-1 block text-sm">Sort Order</Label>
                        <Input
                            type="number"
                            placeholder="0"
                            value={sortOrder}
                            onChange={e => setSortOrder(e.target.value)}
                        />
                        <Text className="text-xs text-ui-fg-muted mt-1">Lower numbers appear first in the dropdown.</Text>
                    </div>
                </div>
                <div className="px-6 py-4 border-t border-ui-border-base flex justify-end gap-2">
                    <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={handleSave} isLoading={saving}>Save Default</Button>
                </div>
            </div>
        </div>
    )
}

// ── Scope Modal (edit Applies To for an entire field group) ────────────────────
function ScopeModal({
    fieldName,
    currentScope,
    onClose,
    onSave,
}: {
    fieldName: string
    currentScope: string
    onClose: () => void
    onSave: (newScope: string) => Promise<void>
}) {
    const [dataScope, setDataScope] = useState<string>(currentScope || "customers,orders")
    const [saving, setSaving] = useState(false)

    const handleSave = async () => {
        if (!dataScope) return
        setSaving(true)
        try {
            await onSave(dataScope)
            onClose()
        } catch {
            toast.error("Failed to update scope")
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-[380px] flex flex-col overflow-hidden">
                <div className="px-5 py-4 border-b border-ui-border-base flex items-center justify-between">
                    <div>
                        <Heading level="h2" className="text-base">Edit Scope</Heading>
                        <Text className="text-xs text-ui-fg-muted mt-0.5">{fieldName}</Text>
                    </div>
                    <button onClick={onClose} className="text-ui-fg-muted hover:text-ui-fg-base text-xl leading-none">×</button>
                </div>
                <div className="px-5 py-5 space-y-2">
                    <Label className="mb-2 block text-sm font-medium">Applies To</Label>
                    {ALL_DOC_SCOPES.map(({ key, label }) => {
                        const scopes = dataScope.split(",").map(s => s.trim()).filter(Boolean)
                        const checked = scopes.includes(key)
                        return (
                            <label key={key} className="flex items-center gap-3 cursor-pointer select-none p-2 rounded-md hover:bg-ui-bg-subtle transition-colors">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 cursor-pointer"
                                    checked={checked}
                                    onChange={e => {
                                        const current = dataScope.split(",").map(s => s.trim()).filter(Boolean)
                                        const next = e.target.checked
                                            ? [...new Set([...current, key])]
                                            : current.filter(s => s !== key)
                                        if (next.length === 0) return
                                        setDataScope(next.sort().join(","))
                                    }}
                                />
                                <div>
                                    <span className="text-sm font-medium text-ui-fg-base">{label}</span>
                                    <span className="block text-xs text-ui-fg-muted">
                                        {key === "customers" ? "Customer profile & customer-related docs" : "Estimates, Orders & Invoices"}
                                    </span>
                                </div>
                            </label>
                        )
                    })}
                    <Text className="text-xs text-ui-fg-muted pt-2">Updates all <strong>{fieldName}</strong> options at once.</Text>
                </div>
                <div className="px-5 py-4 border-t border-ui-border-base flex justify-end gap-2">
                    <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={handleSave} isLoading={saving}>Apply to All</Button>
                </div>
            </div>
        </div>
    )
}

// ── Manual User Modal ─────────────────────────────────────────────────────────
function ManualUserModal({
    onClose,
    onSave,
}: {
    onClose: () => void
    onSave: (name: string, initials: string, isSalesRep: boolean) => Promise<void>
}) {
    const [name, setName] = useState("")
    const [initials, setInitials] = useState("")
    const [isSalesRep, setIsSalesRep] = useState(true)
    const [saving, setSaving] = useState(false)

    // Auto-generate initials from name
    const handleNameChange = (val: string) => {
        setName(val)
        const parts = val.trim().split(/\s+/)
        const auto = parts.map(p => p[0] ?? "").join("").toUpperCase().slice(0, 3)
        setInitials(auto)
    }

    const handleSave = async () => {
        if (!name.trim()) { toast.error("Name is required"); return }
        setSaving(true)
        try {
            await onSave(name.trim(), initials.trim().toUpperCase() || name[0]?.toUpperCase() || "?", isSalesRep)
            onClose()
        } catch {
            toast.error("Failed to create user")
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-[400px] flex flex-col overflow-hidden">
                <div className="px-6 py-4 border-b border-ui-border-base flex items-center justify-between">
                    <Heading level="h2" className="text-base">Add Manual User</Heading>
                    <button onClick={onClose} className="text-ui-fg-muted hover:text-ui-fg-base text-xl leading-none">×</button>
                </div>
                <div className="px-6 py-5 space-y-4">
                    <Text className="text-xs text-ui-fg-muted">
                        Adds a user that is not linked to a Medusa account (e.g. a channel or role like "Web").
                    </Text>
                    <div>
                        <Label className="mb-1 block text-sm">Name <span className="text-ui-fg-error">*</span></Label>
                        <Input
                            placeholder='e.g. Web, Walk-in, Phone'
                            value={name}
                            onChange={e => handleNameChange(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <div>
                        <Label className="mb-1 block text-sm">Initials</Label>
                        <Input
                            placeholder="e.g. WB"
                            value={initials}
                            onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                            className="uppercase w-24"
                        />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer"
                            checked={isSalesRep}
                            onChange={e => setIsSalesRep(e.target.checked)}
                        />
                        <span className="text-sm text-ui-fg-base">Mark as Sales Rep</span>
                    </label>
                </div>
                <div className="px-6 py-4 border-t border-ui-border-base flex justify-end gap-2">
                    <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={handleSave} isLoading={saving}>Add User</Button>
                </div>
            </div>
        </div>
    )
}

// ── DraggableItems ─────────────────────────────────────────────────────────────
function DraggableOptionList({
    items,
    onReorder,
    onEdit,
    onDelete,
    deleteConfirm,
    setDeleteConfirm,
}: {
    items: SystemDefault[]
    onReorder: (reordered: SystemDefault[]) => Promise<void>
    onEdit: (item: SystemDefault) => void
    onDelete: (id: string) => void
    deleteConfirm: string | null
    setDeleteConfirm: (id: string | null) => void
}) {
    const [localItems, setLocalItems] = useState<SystemDefault[]>(items)
    const [draggingId, setDraggingId] = useState<string | null>(null)
    const [dragOverId, setDragOverId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const dragItem = useRef<SystemDefault | null>(null)

    // Sync when parent items change (after a reload)
    useEffect(() => {
        setLocalItems([...items].sort((a, b) => a.sort_order - b.sort_order))
    }, [items])

    const handleDragStart = (e: React.DragEvent, item: SystemDefault) => {
        dragItem.current = item
        setDraggingId(item.id)
        e.dataTransfer.effectAllowed = "move"
    }

    const handleDragOver = (e: React.DragEvent, targetId: string) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        if (targetId !== dragOverId) setDragOverId(targetId)
    }

    const handleDrop = async (e: React.DragEvent, targetId: string) => {
        e.preventDefault()
        if (!dragItem.current || dragItem.current.id === targetId) {
            setDraggingId(null)
            setDragOverId(null)
            dragItem.current = null
            return
        }

        const fromId = dragItem.current.id
        const current = [...localItems]
        const fromIdx = current.findIndex(i => i.id === fromId)
        const toIdx = current.findIndex(i => i.id === targetId)
        if (fromIdx === -1 || toIdx === -1) return

        // Reorder array
        const reordered = [...current]
        const [moved] = reordered.splice(fromIdx, 1)
        reordered.splice(toIdx, 0, moved!)

        // Reassign sort_order (1-based)
        const withNewOrder = reordered.map((item, idx) => ({ ...item, sort_order: idx + 1 }))

        setLocalItems(withNewOrder)
        setDraggingId(null)
        setDragOverId(null)
        dragItem.current = null

        // Find only the items whose sort_order actually changed
        const changed = withNewOrder.filter((item, idx) => item.sort_order !== current[idx]?.sort_order)
        if (changed.length === 0) return

        setSaving(true)
        try {
            await onReorder(withNewOrder)
        } finally {
            setSaving(false)
        }
    }

    const handleDragEnd = () => {
        setDraggingId(null)
        setDragOverId(null)
        dragItem.current = null
    }

    return (
        <div className={`divide-y divide-ui-border-base flex-1 relative ${saving ? "opacity-70 pointer-events-none" : ""}`}>
            {localItems.map((p: SystemDefault, idx) => (
                <div
                    key={p.id}
                    draggable
                    onDragStart={e => handleDragStart(e, p)}
                    onDragOver={e => handleDragOver(e, p.id)}
                    onDrop={e => handleDrop(e, p.id)}
                    onDragEnd={handleDragEnd}
                    className={`
                        px-4 py-2 flex items-center justify-between group transition-colors cursor-default
                        ${draggingId === p.id ? "opacity-40 bg-ui-bg-subtle" : "hover:bg-ui-bg-base-hover"}
                        ${dragOverId === p.id && draggingId !== p.id ? "border-t-2 border-ui-border-interactive bg-ui-bg-highlight" : ""}
                    `}
                >
                    <div className="flex items-center gap-3">
                        {/* Drag handle */}
                        <span
                            className="text-ui-fg-muted cursor-grab active:cursor-grabbing select-none text-sm leading-none hover:text-ui-fg-base transition-colors"
                            title="Drag to reorder"
                        >
                            ⠿
                        </span>
                        <span className="text-xs text-ui-fg-muted w-4 inline-block text-right">{idx + 1}.</span>
                        <Text className="text-sm">{p.value}</Text>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="transparent" size="small" onClick={() => onEdit(p)} className="h-6 w-6 p-0 text-ui-fg-muted hover:text-ui-fg-base">
                            <span className="text-xs">Edit</span>
                        </Button>
                        {deleteConfirm === p.id ? (
                            <div className="flex gap-1">
                                <Button variant="danger" size="small" onClick={() => onDelete(p.id)} className="h-6 px-2 text-xs">Yes</Button>
                                <Button variant="transparent" size="small" onClick={() => setDeleteConfirm(null)} className="h-6 px-2 text-xs">No</Button>
                            </div>
                        ) : (
                            <Button variant="transparent" size="small" onClick={() => setDeleteConfirm(p.id)} className="h-6 w-6 p-0 text-ui-fg-muted hover:text-ui-error">
                                <span className="text-xs">Del</span>
                            </Button>
                        )}
                    </div>
                </div>
            ))}
        </div>
    )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
const SystemDefaultsPage = () => {
    const [defaults, setDefaults] = useState<SystemDefault[]>([])
    const [loading, setLoading] = useState(true)
    const [modal, setModal] = useState<Partial<SystemDefault> | null | false>(false)
    const [scopeModal, setScopeModal] = useState<{ fieldName: string; items: SystemDefault[] } | null>(null)
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
    const [syncingUsers, setSyncingUsers] = useState(false)
    const [manualUserModal, setManualUserModal] = useState(false)

    const load = useCallback(async (background = false) => {
        if (!background) setLoading(true)
        try {
            const r = await fetch("/admin/system-defaults", { credentials: "include" })
            const { defaults: data } = await r.json()
            setDefaults(data ?? [])
        } catch {
            toast.error("Failed to load system defaults")
        } finally {
            if (!background) setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const handleSave = useCallback(async (data: Partial<SystemDefault>) => {
        if (modal && (modal as SystemDefault).id) {
            const r = await fetch(`/admin/system-defaults/${(modal as SystemDefault).id}`, {
                method: "PATCH", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            })
            if (!r.ok) throw new Error()
            toast.success("System default updated")
        } else {
            const r = await fetch("/admin/system-defaults", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            })
            if (!r.ok) throw new Error()
            toast.success("System default created")
        }
        await load(true)
    }, [modal, load])

    const handleDelete = useCallback(async (id: string) => {
        try {
            await fetch(`/admin/system-defaults/${id}`, { method: "DELETE", credentials: "include" })
            toast.success("Deleted")
            setDeleteConfirm(null)
            await load(true)
        } catch {
            toast.error("Failed to delete")
        }
    }, [load])

    const handleSyncUsers = useCallback(async () => {
        setSyncingUsers(true)
        try {
            const r = await fetch("/admin/system-defaults/sync-users", {
                method: "POST",
                credentials: "include",
            })
            if (!r.ok) throw new Error()
            const result = await r.json()
            if (result.skipped) {
                toast.info(result.message)
            } else {
                toast.success(`Synced ${result.count} active users to Sales Rep.`)
            }
            await load()
        } catch {
            toast.error("Failed to sync Medusa Users")
        } finally {
            setSyncingUsers(false)
        }
    }, [load])

    const handleAddManualUser = useCallback(async (name: string, initials: string, isSalesRep: boolean) => {
        const existingUsers = (contextGroups["Global"]?.["Sales Rep User"] ?? [])
        const maxSort = existingUsers.reduce((max, u) => Math.max(max, u.sort_order), 0)
        const newUserObj = {
            medusa_id: `manual-${Date.now()}`,
            name,
            initials,
            email: null,
            is_sales_rep: isSalesRep,
            active: true,
        }
        const r = await fetch("/admin/system-defaults", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                context: "Global",
                field_name: "Sales Rep User",
                value: JSON.stringify(newUserObj),
                sort_order: maxSort + 1,
                data_scope: "orders",
            }),
        })
        if (!r.ok) throw new Error()
        toast.success(`"${name}" added as a manual user.`)
        await load(true)
    }, [load])  // eslint-disable-line react-hooks/exhaustive-deps

    const handleUserUpdate = useCallback(async (item: SystemDefault, newParsedValue: any) => {
        try {
            const r = await fetch(`/admin/system-defaults/${item.id}`, {
                method: "PATCH", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: JSON.stringify(newParsedValue) }),
            })
            if (!r.ok) throw new Error()
            await load(true)
        } catch {
            toast.error("Failed to update user")
        }
    }, [load])

    // Bulk-update data_scope for all items in a field group
    const handleSaveScope = useCallback(async (items: SystemDefault[], newScope: string) => {
        await Promise.all(items.map(item =>
            fetch(`/admin/system-defaults/${item.id}`, {
                method: "PATCH", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data_scope: newScope }),
            })
        ))
        toast.success("Scope updated")
        await load(true)
    }, [load])

    // Reorder handler: PATCHes only the changed sort_orders
    const handleReorder = useCallback(async (reordered: SystemDefault[]) => {
        const original = defaults.filter(d => reordered.some(r => r.id === d.id))
        const changed = reordered.filter((item) => {
            const orig = original.find(o => o.id === item.id)
            return orig && orig.sort_order !== item.sort_order
        })
        if (changed.length === 0) return
        await Promise.all(
            changed.map(item =>
                fetch(`/admin/system-defaults/${item.id}`, {
                    method: "PATCH", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sort_order: item.sort_order }),
                })
            )
        )
        // Update local defaults state so future reorders use up-to-date sort_orders
        setDefaults(prev => prev.map(d => {
            const updated = reordered.find(r => r.id === d.id)
            return updated ? { ...d, sort_order: updated.sort_order } : d
        }))
        toast.success("Order saved")
    }, [defaults])

    // Grouping: Context -> Field -> Values
    const contextGroups: Record<string, Record<string, SystemDefault[]>> = {}

    for (const d of defaults) {
        if (!contextGroups[d.context]) contextGroups[d.context] = {}
        const ctxGroup = contextGroups[d.context]!
        if (!ctxGroup[d.field_name]) ctxGroup[d.field_name] = []
        ctxGroup[d.field_name]!.push(d)
    }

    const contextOrder = [...KNOWN_CONTEXTS, ...Object.keys(contextGroups).filter(c => !KNOWN_CONTEXTS.includes(c))]

    return (
        <div className="p-6 space-y-6 max-w-5xl mx-auto pb-20">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level="h1">System Defaults</Heading>
                    <Text className="text-ui-fg-muted mt-1">
                        Manage central dropdown options (Lead Times, Terms, Order Types, etc.) for the POS system.
                    </Text>
                </div>
                <Button onClick={() => setModal({})}>+ Add Default</Button>
            </div>

            {loading ? (
                <Text className="text-ui-fg-muted">Loading…</Text>
            ) : (
                <>
                    {/* Dedicated Sales Rep (Medusa Users) Table */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between border-b border-ui-border-base pb-2">
                            <div className="flex items-center gap-2">
                                <Heading level="h2" className="text-lg">POS Users / Sales Reps</Heading>
                                <Badge color="blue">{contextGroups["Global"]?.["Sales Rep User"]?.length ?? 0} synced</Badge>
                            </div>
                            <div className="flex gap-2">
                                <Button
                                    variant="secondary"
                                    size="small"
                                    onClick={() => setManualUserModal(true)}
                                >
                                    + Add Manual User
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="small"
                                    isLoading={syncingUsers}
                                    onClick={handleSyncUsers}
                                >
                                    Sync with Medusa Users
                                </Button>
                            </div>
                        </div>

                        <Container className="p-0 overflow-hidden">
                            <div className="overflow-x-auto w-full">
                                <table className="w-full text-left text-sm whitespace-nowrap">
                                    <thead className="bg-ui-bg-subtle border-b border-ui-border-base text-xs text-ui-fg-muted uppercase">
                                        <tr>
                                            <th className="px-4 py-3 font-medium">User / Email</th>
                                            <th className="px-4 py-3 font-medium text-center">Is Sales Rep?</th>
                                            <th className="px-4 py-3 font-medium">Initials</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-ui-border-base">
                                        {(contextGroups["Global"]?.["Sales Rep User"] || [])
                                            .sort((a, b) => a.sort_order - b.sort_order)
                                            .map((item) => {
                                                let userObj: any = {}
                                                try { userObj = JSON.parse(item.value) } catch { return null }

                                                return (
                                                    <tr key={item.id} className="hover:bg-ui-bg-base-hover group">
                                                        <td className="px-4 py-3">
                                                            <div className="font-medium text-ui-fg-base">{userObj.name}</div>
                                                            {userObj.email ? (
                                                                <div className="text-xs text-ui-fg-muted">{userObj.email}</div>
                                                            ) : (
                                                                <div className="text-xs text-ui-fg-subtle italic">Manual user — no email</div>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3 text-center align-middle">
                                                            <input
                                                                type="checkbox"
                                                                className="cursor-pointer h-4 w-4"
                                                                checked={!!userObj.is_sales_rep}
                                                                onChange={(e) => handleUserUpdate(item, { ...userObj, is_sales_rep: e.target.checked })}
                                                            />
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            <Input
                                                                className="w-20 text-center uppercase"
                                                                defaultValue={userObj.initials}
                                                                onBlur={(e) => {
                                                                    if (e.target.value.toUpperCase() !== userObj.initials) {
                                                                        handleUserUpdate(item, { ...userObj, initials: e.target.value.toUpperCase() })
                                                                    }
                                                                }}
                                                            />
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        {!(contextGroups["Global"]?.["Sales Rep User"]?.length) && (
                                            <tr>
                                                <td colSpan={3} className="px-4 py-8 text-center text-ui-fg-muted">
                                                    No users synced. Click 'Sync with Medusa Users' to import active users.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </Container>
                    </div>

                    {/* Standard Context Groups */}
                    {contextOrder.filter(c => c !== "Global" && contextGroups[c] && Object.keys(contextGroups[c]).length > 0).map(contextName => (
                        <div key={contextName} className="space-y-4 pt-6">
                            <div className="flex items-center gap-2 border-b border-ui-border-base pb-2">
                                <Heading level="h2" className="text-lg">{contextName}</Heading>
                                <Badge color={CONTEXT_COLORS[contextName] ?? "grey"}>{Object.values(contextGroups[contextName] ?? {}).flat().length} items</Badge>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {Object.entries(contextGroups[contextName] ?? {}).map(([fieldName, items]) => {
                                    const fieldScope: string | undefined = (items[0] as any)?.data_scope
                                    const scopeKeys = (fieldScope ?? "").split(",").map((s: string) => s.trim()).filter(Boolean) as DocScopeKey[]
                                    const sortedItems = [...items].sort((a, b) => a.sort_order - b.sort_order)
                                    return (
                                    <Container key={fieldName} className="p-0 overflow-hidden flex flex-col h-full">
                                        <div className="px-4 py-2.5 bg-ui-bg-subtle border-b border-ui-border-base flex justify-between items-start gap-2">
                                            <div className="flex flex-col gap-1 min-w-0">
                                                <Text className="font-semibold text-sm">{fieldName}</Text>
                                                {scopeKeys.length > 0 && (
                                                    <div className="flex gap-1 flex-wrap">
                                                        {scopeKeys.map(sk => (
                                                            <Badge key={sk} color={SCOPE_BADGE_COLOR[sk] ?? "grey"} className="text-xs">
                                                                {ALL_DOC_SCOPES.find(s => s.key === sk)?.label ?? sk}
                                                            </Badge>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <Text className="text-xs text-ui-fg-muted">{items.length} options</Text>
                                                <button
                                                    title="Edit scope (Applies To)"
                                                    className="text-ui-fg-muted hover:text-ui-fg-base text-xs px-1.5 py-0.5 rounded hover:bg-ui-bg-base-hover transition-colors"
                                                    onClick={() => setScopeModal({ fieldName, items: items as SystemDefault[] })}
                                                >&#9999;&#65039;</button>
                                            </div>
                                        </div>

                                        {/* Drag-and-drop list */}
                                        <DraggableOptionList
                                            items={sortedItems}
                                            onReorder={handleReorder}
                                            onEdit={p => setModal(p)}
                                            onDelete={handleDelete}
                                            deleteConfirm={deleteConfirm}
                                            setDeleteConfirm={setDeleteConfirm}
                                        />

                                        <div className="p-2 border-t border-ui-border-base bg-ui-bg-field">
                                            <Button
                                                variant="transparent"
                                                size="small"
                                                className="w-full text-ui-fg-muted text-xs hover:bg-ui-bg-subtle-hover h-7"
                                                onClick={() => setModal({
                                                    context: contextName,
                                                    field_name: fieldName,
                                                    sort_order: items.length + 1,
                                                    data_scope: fieldScope ?? "customers,orders",
                                                })}
                                            >
                                                + Add {fieldName} option
                                            </Button>
                                        </div>
                                    </Container>
                                    )
                                })}
                            </div>
                        </div>
                    ))}
                </>
            )}

            {/* Add/Edit Default Modal */}
            {modal !== false && (
                <DefaultModal
                    item={modal}
                    onClose={() => setModal(false)}
                    onSave={handleSave}
                />
            )}

            {/* Edit Scope Modal */}
            {scopeModal && (
                <ScopeModal
                    fieldName={scopeModal.fieldName}
                    currentScope={(scopeModal.items[0] as any)?.data_scope ?? "customers,orders"}
                    onClose={() => setScopeModal(null)}
                    onSave={(newScope) => handleSaveScope(scopeModal.items, newScope)}
                />
            )}

            {/* Manual User Modal */}
            {manualUserModal && (
                <ManualUserModal
                    onClose={() => setManualUserModal(false)}
                    onSave={handleAddManualUser}
                />
            )}
        </div>
    )
}

export const config = defineRouteConfig({
    label: "System Defaults",
    icon: CogSixTooth,
})

export default SystemDefaultsPage
