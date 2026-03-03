// ─── Types & Constants for Draft Order Detail ─────────────────────────────────

export const ESTIMATE_STATUSES = ["Created", "Sent", "Confirmed Reception", "Followed Up", "Approved", "Not Approved", "Duplicate"] as const
export type EstimateStatus = typeof ESTIMATE_STATUSES[number]
export type ModalType = "sales-channel" | "email" | "shipping-addr" | "billing-addr" | "transfer" | "add-shipping" | "edit-items" | "metadata" | null

export const STATUS_COLOR: Record<EstimateStatus, "grey" | "blue" | "purple" | "orange" | "green" | "red"> = {
    "Created": "grey", "Sent": "blue", "Confirmed Reception": "purple",
    "Followed Up": "orange", "Approved": "green", "Not Approved": "red", "Duplicate": "grey",
}

export interface AddrForm {
    first_name: string; last_name: string; company?: string
    address_1: string; address_2: string; city: string
    province: string; postal_code: string; country_code: string; phone?: string
}

export const emptyAddr = (): AddrForm => ({
    first_name: "", last_name: "", company: "", address_1: "", address_2: "",
    city: "", province: "", postal_code: "", country_code: "US", phone: ""
})

export interface OrderItem {
    id: string; title: string; quantity: number; unit_price: number; subtotal: number
    variant?: { title?: string; sku?: string }
}

export interface ShippingMethod { id: string; name: string; amount: number }

export interface DraftOrderDetail {
    id: string; display_id: number; status: string; currency_code: string; email?: string
    subtotal: number; shipping_total: number; discount_total: number; tax_total: number; total: number
    created_at: string; metadata?: Record<string, any>
    customer?: { id: string; first_name?: string; last_name?: string; email?: string; phone?: string; company_name?: string }
    shipping_address?: AddrForm & { country_code: string }
    billing_address?: AddrForm & { country_code: string }
    sales_channel?: { id: string; name: string }
    region?: { name: string; id: string }
    items: OrderItem[]
    shipping_methods?: ShippingMethod[]
    promotions?: { id: string; code?: string; type?: string; value?: number }[]
}

export interface VariantResult {
    id: string; title: string; sku?: string; variantTitle?: string; thumbnail?: string
}
