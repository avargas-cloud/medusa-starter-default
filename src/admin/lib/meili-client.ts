// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MeiliSearch } = require("meilisearch");

/**
 * MeiliSearch Client Configuration
 * 
 * Uses secure frontend-only Search API Key (read-only permissions).
 * Configured via Vite environment variables for security.
 */

const HOST: string = (typeof process !== "undefined" ? process.env.VITE_MEILISEARCH_HOST : undefined) || "";
const API_KEY: string = (typeof process !== "undefined" ? process.env.VITE_MEILISEARCH_SEARCH_KEY : undefined) || "";

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
