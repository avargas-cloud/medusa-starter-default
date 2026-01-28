import { MeiliSearch } from "meilisearch"

/**
 * Backend MeiliSearch Client
 * Uses MASTER KEY for write operations (not exposed to frontend)
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
        customer_type: customer.metadata?.customer_type || "Standard",
        price_level: customer.metadata?.price_level || "Retail",
        customer_group_ids: customer.groups?.map((g: any) => g.id) || [],
        updated_at: new Date(customer.updated_at).getTime(),
        created_at: new Date(customer.created_at).getTime(),
    }
}
