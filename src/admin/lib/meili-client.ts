// @ts-ignore — import.meta.env is valid in Vite/admin SPA context (TS1479 false positive)
import { MeiliSearch } from "meilisearch";

/**
 * MeiliSearch Client Configuration
 *
 * Uses secure frontend-only Search API Key (read-only permissions).
 * Configured via Vite environment variables for security.
 */

// @ts-ignore
const RAW_HOST: string = import.meta.env?.VITE_MEILISEARCH_HOST || "";
// @ts-ignore
const API_KEY: string = import.meta.env?.VITE_MEILISEARCH_SEARCH_KEY || "";

function normalizeHost(host: string) {
  const normalized = host.trim().replace(/^['"]+|['"]+$/g, "");

  if (!normalized) {
    return "";
  }

  try {
    return new URL(normalized).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

const HOST = normalizeHost(RAW_HOST);
const IS_CONFIGURED = Boolean(HOST && API_KEY);

if (!IS_CONFIGURED) {
  console.warn(
    "[MeiliSearch] Missing environment variables. " +
      "Ensure VITE_MEILISEARCH_HOST and VITE_MEILISEARCH_SEARCH_KEY are set."
  );
}

type MeiliClient = {
  index: MeiliSearch["index"];
};

function createUnconfiguredClient(): MeiliClient {
  return {
    index() {
      throw new Error(
        "MeiliSearch admin client is not configured. Set VITE_MEILISEARCH_HOST and VITE_MEILISEARCH_SEARCH_KEY, then rebuild the admin bundle."
      );
    },
  };
}

/**
 * Configured MeiliSearch client instance
 */
export const meiliClient: MeiliClient = IS_CONFIGURED
  ? new MeiliSearch({
      host: HOST,
      apiKey: API_KEY,
    })
  : createUnconfiguredClient();

console.log(
  "[MeiliClient] Initialized with Host:",
  HOST ? "Set" : "Missing",
  "Key:",
  API_KEY ? "Set" : "Missing"
);

/**
 * Primary products index name (matches backend configuration)
 */
export const PRODUCTS_INDEX = "products";

/**
 * Inventory items index name (matches backend configuration)
 */
export const INVENTORY_INDEX = "inventory";

/**
 * Customers index name (matches backend subscriber configuration)
 */
export const CUSTOMERS_INDEX = "customers";
