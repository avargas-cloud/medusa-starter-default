/**
 * qb-bridge-client.ts (Legacy Proxy)
 *
 * This file has been refactored into modular components inside `src/lib/quickbooks/client/`.
 * It now acts purely as a backward-compatibility proxy that exports the modularized client.
 */

export * from "./client/index";
