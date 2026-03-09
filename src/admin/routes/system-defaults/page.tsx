import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CogSixTooth } from "@medusajs/icons"
import {
    Container, Heading, Button, Input, Label, Text, toast, Badge, Textarea
} from "@medusajs/ui"
import { useState, useEffect, useCallback } from "react"

// ── Types ──────────────────────────────────────────────────────────────────────
interface SystemDefault {
    id: string
    context: string
    field_name: string
    value: string
    sort_order: number
    created_at: string
    updated_at: string
}

const KNOWN_CONTEXTS = ["Document Defaults", "Templates Footer"]

const KNOWN_FIELDS_BY_CONTEXT: Record<string, string[]> = {
    "Document Defaults": ["Terms", "Tax Code", "Price List", "Estimate Status", "Order Status", "Order Type", "Lead Time", "FOB", "Ship Via", "Project Phase", "Payment Terms"],
    "Templates Footer": ["Draft Order (Estimates)", "Order (Sales Order)", "Invoice"],
}

const CONTEXT_COLORS: Record<string, "blue" | "green" | "orange" | "purple" | "grey"> = {
    "Document Defaults": "blue",
    "Templates Footer": "purple",
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
    const [context, setContext] = useState(item?.context ?? KNOWN_CONTEXTS[0])
    const [customContext, setCustomContext] = useState("")

    const availableFields = KNOWN_FIELDS_BY_CONTEXT[context] || []
    const initialField = item?.field_name || (availableFields.length > 0 ? availableFields[0] : "")

    const [field, setField] = useState(initialField)
    const [customField, setCustomField] = useState("")

    const [value, setValue] = useState(item?.value ?? "")
    const [sortOrder, setSortOrder] = useState(item?.sort_order?.toString() ?? "0")
    const [saving, setSaving] = useState(false)

    // Auto-infer context from field
    useEffect(() => {
        if (field !== "__custom__") {
            const contextForField = KNOWN_CONTEXTS.find(c => KNOWN_FIELDS_BY_CONTEXT[c]?.includes(field))
            if (contextForField) {
                setContext(contextForField)
            }
        }
    }, [field])

    const isCustomContext = !KNOWN_CONTEXTS.includes(context) && context !== "__custom__"
    const isCustomField = field === "__custom__" || (context !== "__custom__" && !(KNOWN_FIELDS_BY_CONTEXT[context] || []).includes(field))

    const handleSave = async () => {
        const c = context === "__custom__" ? customContext.trim() : (isCustomContext ? context : context)
        const f = field === "__custom__" ? customField.trim() : (isCustomField && field !== "__custom__" ? field : field)
        const v = value.trim()
        const order = parseInt(sortOrder, 10) || 0

        if (!c || !f || !v) {
            toast.error("Context, Field, and Value are required")
            return
        }
        setSaving(true)
        try {
            await onSave({ context: c, field_name: f, value: v, sort_order: order })
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
                            value={Object.values(KNOWN_FIELDS_BY_CONTEXT).flat().includes(field) ? field : "__custom__"}
                            onChange={e => {
                                setField(e.target.value)
                                if (e.target.value !== "__custom__") setCustomField("")
                            }}
                            className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base"
                        >
                            <optgroup label="Document Defaults" className="bg-ui-bg-base text-ui-fg-base font-semibold">
                                {KNOWN_FIELDS_BY_CONTEXT["Document Defaults"].map(f => <option key={f} value={f} className="bg-ui-bg-base text-ui-fg-base font-normal">{f}</option>)}
                            </optgroup>
                            <optgroup label="Templates Footer" className="bg-ui-bg-base text-ui-fg-base font-semibold">
                                {KNOWN_FIELDS_BY_CONTEXT["Templates Footer"].map(f => <option key={f} value={f} className="bg-ui-bg-base text-ui-fg-base font-normal">{f}</option>)}
                            </optgroup>
                            <option value="__custom__" className="bg-ui-bg-base text-ui-fg-base">Custom field…</option>
                        </select>
                        {(field === "__custom__" || isCustomField) && (
                            <Input
                                className="mt-3"
                                placeholder="Custom field name (e.g. Shipping Method)"
                                value={field === "__custom__" ? customField : field}
                                onChange={e => field === "__custom__" ? setCustomField(e.target.value) : setField(e.target.value)}
                            />
                        )}
                        {(field === "__custom__" || isCustomField) && (
                            <div className="mt-3">
                                <Label className="mb-1 block text-sm">Target Context Area</Label>
                                <select
                                    value={context}
                                    onChange={e => setContext(e.target.value)}
                                    className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-field text-ui-fg-base"
                                >
                                    <option value="Document Defaults">Document Defaults</option>
                                    <option value="Templates Footer">Templates Footer</option>
                                    <option value="__custom__">Custom Context...</option>
                                </select>
                            </div>
                        )}
                        {(context === "__custom__" || isCustomContext) && (field === "__custom__" || isCustomField) && (
                            <Input
                                className="mt-2"
                                placeholder="Custom context name (e.g. Invoice Defaults)"
                                value={context === "__custom__" ? customContext : context}
                                onChange={e => context === "__custom__" ? setCustomContext(e.target.value) : setContext(e.target.value)}
                            />
                        )}
                    </div>

                    {/* Value */}
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
                        ) : (
                            <Input
                                placeholder="e.g. Net 30, Standard Order, 5-7 Days..."
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

// ── Main Page ──────────────────────────────────────────────────────────────────
const SystemDefaultsPage = () => {
    const [defaults, setDefaults] = useState<SystemDefault[]>([])
    const [loading, setLoading] = useState(true)
    const [modal, setModal] = useState<Partial<SystemDefault> | null | false>(false)
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
    const [syncingUsers, setSyncingUsers] = useState(false)

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

    // Grouping: Context -> Field -> Values
    const contextGroups: Record<string, Record<string, SystemDefault[]>> = {}

    for (const d of defaults) {
        if (!contextGroups[d.context]) contextGroups[d.context] = {}
        if (!contextGroups[d.context][d.field_name]) contextGroups[d.context][d.field_name] = []
        contextGroups[d.context][d.field_name].push(d)
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
                            <Button
                                variant="secondary"
                                size="small"
                                isLoading={syncingUsers}
                                onClick={handleSyncUsers}
                            >
                                Sync with Medusa Users
                            </Button>
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
                                                            <div className="text-xs text-ui-fg-muted">{userObj.email}</div>
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
                                <Badge color={CONTEXT_COLORS[contextName] ?? "grey"}>{Object.values(contextGroups[contextName]).flat().length} items</Badge>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {Object.entries(contextGroups[contextName]).map(([fieldName, items]) => (
                                    <Container key={fieldName} className="p-0 overflow-hidden flex flex-col h-full">
                                        <div className="px-4 py-2.5 bg-ui-bg-subtle border-b border-ui-border-base flex justify-between items-center">
                                            <Text className="font-semibold text-sm">{fieldName}</Text>
                                            <Text className="text-xs text-ui-fg-muted">{items.length} options</Text>
                                        </div>
                                        <div className="divide-y divide-ui-border-base flex-1">
                                            {items.sort((a, b) => a.sort_order - b.sort_order).map((p: SystemDefault) => (
                                                <div key={p.id} className="px-4 py-2 hover:bg-ui-bg-base-hover flex items-center justify-between group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-xs text-ui-fg-muted w-4 inline-block text-right">{p.sort_order}.</span>
                                                        <Text className="text-sm">{p.value}</Text>
                                                    </div>
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <Button variant="transparent" size="small" onClick={() => setModal(p)} className="h-6 w-6 p-0 text-ui-fg-muted hover:text-ui-fg-base">
                                                            <span className="text-xs">Edit</span>
                                                        </Button>
                                                        {deleteConfirm === p.id ? (
                                                            <div className="flex gap-1">
                                                                <Button variant="danger" size="small" onClick={() => handleDelete(p.id)} className="h-6 px-2 text-xs">Yes</Button>
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
                                        <div className="p-2 border-t border-ui-border-base bg-ui-bg-field">
                                            <Button
                                                variant="transparent"
                                                size="small"
                                                className="w-full text-ui-fg-muted text-xs hover:bg-ui-bg-subtle-hover h-7"
                                                onClick={() => setModal({ context: contextName, field_name: fieldName, sort_order: items.length + 1 })}
                                            >
                                                + Add {fieldName} option
                                            </Button>
                                        </div>
                                    </Container>
                                ))}
                            </div>
                        </div>
                    ))}
                </>
            )}

            {/* Modal */}
            {modal !== false && (
                <DefaultModal
                    item={modal}
                    onClose={() => setModal(false)}
                    onSave={handleSave}
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
