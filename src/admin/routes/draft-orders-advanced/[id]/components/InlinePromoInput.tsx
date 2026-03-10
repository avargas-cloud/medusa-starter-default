import { useState, useEffect, useRef } from "react"
import { Text } from "@medusajs/ui"
import { toast } from "@medusajs/ui"

interface Promotion {
    id: string
    code: string
    application_method?: { type?: string; value?: number }
}

interface Props {
    orderId: string
    onApplied: () => void
    appliedCodes?: string[]
}

/**
 * Promotion selector — loads existing promotions from Medusa, lets user search
 * and then click to immediately apply (no separate "Apply" button needed).
 */
export const InlinePromoInput = ({ orderId, onApplied, appliedCodes = [] }: Props) => {
    const [promotions, setPromotions] = useState<Promotion[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState("")
    const [open, setOpen] = useState(false)
    const [applying, setApplying] = useState<string | null>(null)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        fetch("/admin/promotions?limit=100", { credentials: "include" })
            .then(r => r.ok ? r.json() : { promotions: [] })
            .then(j => setPromotions(j.promotions ?? []))
            .catch(() => setPromotions([]))
            .finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        const h = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener("mousedown", h)
        return () => document.removeEventListener("mousedown", h)
    }, [])

    const applyPromo = async (code: string) => {
        if (applying) return
        setApplying(code)
        try {
            const r = await fetch(`/admin/orders/${orderId}/promotions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ promo_codes: [code] }),
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.message || `HTTP ${r.status}`)
            }
            toast.success(`"${code}" applied`)
            setSearch(""); setOpen(false)
            onApplied()
        } catch (e: any) {
            toast.error(e.message)
        } finally { setApplying(null) }
    }

    const filtered = promotions.filter(p => !appliedCodes.includes(p.code) && !p.code?.startsWith("CUSTOM-DISC-")).filter(p =>
        !search || p.code?.toLowerCase().includes(search.toLowerCase())
    )

    if (loading) {

        return <Text size="xsmall" className="text-ui-fg-muted py-2">Loading promotions…</Text>
    }

    if (promotions.length === 0) {
        return (
            <div className="py-3 text-center rounded-md border border-dashed border-ui-border-base">
                <Text size="small" className="text-ui-fg-muted">No promotions configured in this store.</Text>
            </div>
        )
    }

    return (
        <div ref={ref} className="relative">
            <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
                placeholder="Search promotions to apply…"
                className="w-full border border-ui-border-base rounded-md px-3 py-1.5 text-sm bg-ui-bg-base text-ui-fg-base placeholder:text-ui-fg-muted focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
            />
            {open && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-ui-bg-base border border-ui-border-base rounded-md shadow-lg z-20 max-h-48 overflow-y-auto">
                    {filtered.length > 0 ? filtered.map(p => {
                        const method = p.application_method
                        const label = method?.type === "percentage"
                            ? `${method.value}% off`
                            : method?.type === "fixed" ? "Fixed discount" : ""
                        return (
                            <button key={p.id}
                                onClick={() => applyPromo(p.code)}
                                disabled={!!applying}
                                className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-ui-bg-subtle border-b border-ui-border-base last:border-0 text-left disabled:opacity-60"
                            >
                                <span className="text-sm font-mono font-medium text-ui-fg-base">{p.code}</span>
                                {label && <span className="text-xs text-ui-fg-subtle">{label}</span>}
                                {applying === p.code && <span className="text-xs text-ui-fg-muted ml-2">Applying…</span>}
                            </button>
                        )
                    }) : (
                        <div className="px-3 py-3 text-sm text-ui-fg-muted text-center">
                            No promotions match "{search}"
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
