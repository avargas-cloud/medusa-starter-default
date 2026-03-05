import { useState, useEffect, useRef } from "react"
import { Text, toast } from "@medusajs/ui"

const PRESETS = [
    { label: "Payment Terms", text: "Payment is due within 30 days of estimate approval. A 50% deposit is required to begin work." },
    { label: "Lead Time", text: "Lead time: 5-7 business days from order confirmation. Installation scheduling will be coordinated upon approval." },
    { label: "Validity", text: "This estimate is valid for 30 days from the date issued. Prices are subject to change after expiration." },
    { label: "Warranty", text: "All products carry manufacturer warranty. Installation work is warranted for 1 year from completion date." },
    { label: "Scope Note", text: "Scope of work includes: [describe scope]. Materials, labor, and cleanup are included unless otherwise stated." },
]

interface Props {
    orderId: string
    initialNotes?: string
}

export const InlineNotes = ({ orderId, initialNotes = "" }: Props) => {
    const [notes, setNotes] = useState(initialNotes)
    const [saving, setSaving] = useState(false)
    const [dirty, setDirty] = useState(false)
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => { setNotes(initialNotes) }, [initialNotes])

    const save = async (value: string) => {
        setSaving(true)
        try {
            const r = await fetch(`/admin/draft-orders/${orderId}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ metadata: { estimate_notes: value } }),
            })
            if (!r.ok) throw new Error("Save failed")
            setDirty(false)
        } catch {
            toast.error("Failed to save notes")
        } finally { setSaving(false) }
    }

    const handleChange = (value: string) => {
        setNotes(value)
        setDirty(true)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => save(value), 1000)
    }

    const applyPreset = (text: string) => {
        const newNotes = notes ? `${notes}\n\n${text}` : text
        handleChange(newNotes)
    }

    return (
        <div className="px-6 py-4">
            {/* Preset chips */}
            <div className="flex flex-wrap gap-2 mb-3">
                <Text size="xsmall" className="text-ui-fg-muted self-center mr-1">Templates:</Text>
                {PRESETS.map(p => (
                    <button
                        key={p.label}
                        onClick={() => applyPreset(p.text)}
                        className="text-xs px-2.5 py-1 rounded-full border border-ui-border-base bg-ui-bg-base hover:bg-ui-bg-subtle-hover text-ui-fg-subtle transition-colors"
                    >
                        {p.label}
                    </button>
                ))}
            </div>

            {/* Text area */}
            <textarea
                value={notes}
                onChange={e => handleChange(e.target.value)}
                placeholder="Add internal notes or customer-facing terms for this estimate…"
                rows={4}
                className="w-full text-sm bg-ui-bg-base border border-ui-border-base rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-1 focus:ring-ui-border-interactive text-ui-fg-base placeholder:text-ui-fg-muted"
            />
            <div className="flex justify-end mt-1">
                <Text size="xsmall" className="text-ui-fg-muted">
                    {saving ? "Saving…" : dirty ? "Unsaved" : "Saved ✓"}
                </Text>
            </div>
        </div>
    )
}
