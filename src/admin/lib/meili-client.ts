import { MeiliSearch } from "meilisearch";

/**
 * MeiliSearch Client Configuration
 * 
 * Uses secure frontend-only Search API Key (read-only permissions).
 * Configured via Vite environment variables for security.
 */

const HOST = import.meta.env.VITE_MEILISEARCH_HOST || "";
const API_KEY = import.meta.env.VITE_MEILISEARCH_SEARCH_KEY || "";

if (!HOST || !API_KEY) {
    console.warn(
        "[MeiliSearch] Missing environment variables. " +
        "Ensure VITE_MEILISEARCH_HOST and VITE_MEILISEARCH_SEARCH_KEY are set."
    );
}

/**
 * Configured MeiliSearch client instance
 */
export const meiliClient = new MeiliSearch({
    host: HOST,
    apiKey: API_KEY,
});

console.log("[MeiliClient] Initialized with Host:", HOST ? "Set" : "Missing", "Key:", API_KEY ? "Set" : "Missing");

/**
 * Primary products index name (matches backend configuration)
 */
export const PRODUCTS_INDEX = "products";

/**
 * Inventory items index name (matches backend configuration)
 */
export const INVENTORY_INDEX = "inventory";
