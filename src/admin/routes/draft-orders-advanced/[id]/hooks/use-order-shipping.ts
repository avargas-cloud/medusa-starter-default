import { toast } from "@medusajs/ui"
import { DraftOrderDetail } from "../types"

interface Deps {
    id: string | undefined
    setOrder: React.Dispatch<React.SetStateAction<DraftOrderDetail | null>>
    selectedOption: string
    customAmount: string
    saving: boolean
    setSaving: (v: boolean) => void
    closeModal: () => void
}

/** Owns add/remove shipping logic with optimistic state updates. */
export const useOrderShipping = ({ id, setOrder, selectedOption, customAmount, setSaving, closeModal }: Deps) => {

    const handleAddShipping = async (optionId?: string, customAmountStr?: string): Promise<void> => {
        const resolvedOption = optionId ?? selectedOption
        const resolvedAmount = customAmountStr !== undefined ? customAmountStr : customAmount
        if (!resolvedOption) { toast.error("Select a shipping option"); return }
        setSaving(true)
        try {
            const body: Record<string, any> = { shipping_option_id: resolvedOption }
            const parsedCustom = resolvedAmount ? parseFloat(resolvedAmount) : NaN
            if (!isNaN(parsedCustom) && parsedCustom >= 0) body.custom_amount = parsedCustom
            const r = await fetch(`/admin/draft-orders/${id}/add-shipping-force`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body)
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }

            toast.success("Shipping method added"); closeModal()

            // Optimistic: fetch shipping option details then patch state
            const shippingOptRes = await fetch(`/admin/shipping-options/${resolvedOption}`, { credentials: "include" }).catch(() => null)
            if (shippingOptRes?.ok) {
                const { shipping_option } = await shippingOptRes.json()
                const optName: string = (shipping_option?.name ?? "").toLowerCase()
                const isPickup = optName.includes("pickup") || optName.includes("store")
                const newAmount = !isNaN(parsedCustom) && parsedCustom >= 0 ? parsedCustom : (shipping_option?.amount ?? 0)

                setOrder(prev => {
                    if (!prev) return prev
                    return {
                        ...prev,
                        shipping_methods: [...(prev.shipping_methods ?? []), { id: `optimistic-${Date.now()}`, name: shipping_option?.name ?? "Shipping", amount: newAmount, data: {} }],
                        shipping_total: (prev.shipping_total ?? 0) + newAmount,
                    }
                })

                if (isPickup || optName.includes("warehouse")) {
                    ; (async () => {
                        try {
                            const fallbackAddr = { first_name: "Ecopowertech", last_name: "Inc", company: "Ecopowertech Inc", address_1: "2760 W 84th St", address_2: "Unit 4", city: "Hialeah", province: "FL", postal_code: "33016", country_code: "us", phone: "" }
                            let addr = fallbackAddr
                            try {
                                const slRes = await fetch(`/admin/stock-locations?limit=100&fields=*,+address.*`, { credentials: "include" })
                                if (slRes.ok) {
                                    const { stock_locations } = await slRes.json()
                                    const words = optName.split(/\s+/).filter((w: string) => w.length > 2)
                                    const match = (stock_locations ?? []).find((sl: any) => words.some((w: string) => (sl.name ?? "").toLowerCase().includes(w))) ?? (stock_locations ?? [])[0]
                                    if (match?.address) {
                                        const a = match.address
                                        addr = { first_name: "Ecopowertech", last_name: "Inc", company: a.company || match.name || "Ecopowertech Inc", address_1: a.address_1 ?? fallbackAddr.address_1, address_2: a.address_2 ?? fallbackAddr.address_2, city: a.city ?? fallbackAddr.city, province: a.province_code ?? a.province ?? fallbackAddr.province, postal_code: a.postal_code ?? fallbackAddr.postal_code, country_code: (a.country_code ?? "us").toLowerCase(), phone: a.phone ?? "" }
                                    }
                                }
                            } catch { }
                            await fetch(`/admin/draft-orders/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ shipping_address: addr }) })
                            setOrder(prev => prev ? { ...prev, shipping_address: addr as any } : prev)
                        } catch (e) { console.warn("[warehouse/pickup] address update failed:", e) }
                    })()
                }

                // Swap optimistic IDs with real ones after 1.5s (background)
                setTimeout(async () => {
                    try {
                        const freshR = await fetch(`/admin/orders/${id}?fields=+shipping_methods.*`, { credentials: "include" })
                        if (freshR.ok) {
                            const { order: freshOrder } = await freshR.json()
                            const freshMethods: any[] = freshOrder?.shipping_methods ?? []
                            if (freshMethods.length > 0) setOrder(prev => prev ? { ...prev, shipping_methods: freshMethods } : prev)
                        }
                    } catch { }
                }, 1500)
            }
        } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
    }

    const handleRemoveShipping = (methodId: string) => {
        setOrder(prev => {
            if (!prev) return prev
            const removed = (prev.shipping_methods ?? []).find((m: any) => m.id === methodId)
            return {
                ...prev,
                shipping_methods: (prev.shipping_methods ?? []).filter((m: any) => m.id !== methodId),
                shipping_total: Math.max(0, (prev.shipping_total ?? 0) - (removed?.amount ?? 0)),
            }
        })
    }

    return { handleAddShipping, handleRemoveShipping }
}
