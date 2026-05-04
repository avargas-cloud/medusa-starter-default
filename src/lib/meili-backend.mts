import { MeiliSearch } from "meilisearch"

/**
 * Backend MeiliSearch Client
 * 
 * Uses master API key for full read/write access
 * Only use this on the server-side (never expose to frontend)
 */
export const meiliClient = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST || "",
    apiKey: process.env.MEILISEARCH_API_KEY || "" // Master key for backend
})

/**
 * Index names (must match medusa-config.ts plugin configuration)
 */
export const PRODUCTS_INDEX = "products"
export const CUSTOMERS_INDEX = "customers"
export const INVENTORY_INDEX = "inventory"
export const VENDORS_INDEX = "vendors"

/**
 * Product transformer (matches medusa-config.ts transformer)
 */
export function transformProduct(product: any) {
    return {
        id: product.id,
        title: product.title,
        description: product.description,
        handle: product.handle,
        thumbnail: product.thumbnail,
        variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        status: product.status,
        metadata: product.metadata || {},
        metadata_material: product.metadata?.material || null,
        metadata_category: product.metadata?.category || null,
        updated_at: new Date(product.updated_at).getTime(),
        created_at: new Date(product.created_at).getTime(),
    }
}

/**
 * Vendor transformer — maps a qb_vendor DB row to a Meili document.
 *
 * Searchable surface: full_name, name, company_name, email, phone,
 * qb_list_id, account_number, tax_identity, city, state, contact.
 * Used by the Purchase Order vendor picker (store-pos) and future
 * vendor-facing UIs.
 */
export function transformVendor(vendor: any) {
    return {
        id: vendor.id,
        qb_list_id: vendor.qb_list_id ?? null,
        full_name: vendor.full_name ?? null,
        name: vendor.name ?? null,
        company_name: vendor.company_name ?? null,
        account_number: vendor.account_number ?? null,
        is_active: vendor.is_active ?? true,

        first_name: vendor.first_name ?? null,
        last_name: vendor.last_name ?? null,
        contact: vendor.contact ?? null,

        email: vendor.email ?? null,
        phone: vendor.phone ?? null,
        alt_phone: vendor.alt_phone ?? null,
        fax: vendor.fax ?? null,

        addr1: vendor.addr1 ?? null,
        addr2: vendor.addr2 ?? null,
        city: vendor.city ?? null,
        state: vendor.state ?? null,
        postal_code: vendor.postal_code ?? null,
        country: vendor.country ?? null,

        terms_ref_name: vendor.terms_ref_name ?? null,
        payment_terms: (vendor.metadata as Record<string, unknown> | null)?.payment_terms as string ?? null,
        vendor_type_ref_name: vendor.vendor_type_ref_name ?? null,
        currency_ref_name: vendor.currency_ref_name ?? null,

        tax_identity: vendor.tax_identity ?? null,
        is_vendor_eligible_for_1099: vendor.is_vendor_eligible_for_1099 ?? null,
        credit_limit: vendor.credit_limit ?? null,

        sync_status: vendor.sync_status ?? null,

        updated_at: vendor.updated_at
            ? new Date(vendor.updated_at).getTime()
            : Date.now(),
        created_at: vendor.created_at
            ? new Date(vendor.created_at).getTime()
            : Date.now(),
    }
}

/**
 * Customer transformer
 */
export function transformCustomer(customer: any) {
    return {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        company_name: customer.metadata?.company_name || customer.company_name || "",
        phone: customer.phone,
        has_account: customer.has_account,
        // QuickBooks metadata
        list_id: customer.metadata?.qb_list_id || "",
        acquisition_channel: customer.metadata?.acquisition_channel || "",
        customer_type: customer.metadata?.qb_customer_type || customer.metadata?.customer_type || "Standard",
        price_level: customer.metadata?.qb_price_level || customer.metadata?.price_level || "Retail",
        customer_group_ids: customer.groups?.map((g: any) => g.id) || [],
        default_tax: customer.metadata?.default_tax || null,
        tax_exempt_reason: customer.metadata?.tax_exempt_reason || null,
        updated_at: new Date(customer.updated_at).getTime(),
        created_at: new Date(customer.created_at).getTime(),
    }
}
