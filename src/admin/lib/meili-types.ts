/**
 * TypeScript type definitions for MeiliSearch indexed documents
 */

/**
 * Product document structure as indexed in MeiliSearch
 * Matches the transformer definition in medusa-config.ts
 */
export type MeiliProduct = {
    /** Product ID (primary key) */
    id: string;

    /** Product title */
    title: string;

    /** Product handle (slug) */
    handle: string;

    /** Product description */
    description: string | null;

    /** Thumbnail URL */
    thumbnail: string | null;

    /** Product status (published/draft) */
    status: "published" | "draft";

    /** Array of category handles for filtering */
    category_handles: string[];

    /** Flattened array of variant SKUs for searchability */
    variant_sku: string[];

    /** Product metadata object */
    metadata: Record<string, any>;

    /** Material extracted from metadata */
    metadata_material: string | null;

    /** Category extracted from metadata */
    metadata_category: string | null;
};

/**
 * MeiliSearch search response structure
 */
export type MeiliSearchResponse<T> = {
    hits: T[];
    query: string;
    processingTimeMs: number;
    limit: number;
    offset: number;
    estimatedTotalHits: number;
};

/**
 * Inventory Item document structure as indexed in MeiliSearch
 * Used for inventory-advanced search and filtering
 */
export type MeiliInventoryItem = {
    /** Inventory Item ID (primary key) */
    id: string;

    /** Product SKU */
    sku: string;

    /** Product/Variant title */
    title: string;

    /** Product thumbnail URL */
    thumbnail: string | null;

    /** Total stock quantity */
    totalStock: number;

    /** Reserved quantity */
    totalReserved: number;

    /** Price in dollars (v2 format) */
    price: number;

    /** Currency code */
    currencyCode: string;

    /** Variant ID for navigation */
    variantId: string | null;

    /** Product ID for navigation */
    productId: string | null;

    /** Array of category handles for filtering (includes parent hierarchy) */
    category_handles: string[];

    /** Product status */
    status: "published" | "draft";
};
