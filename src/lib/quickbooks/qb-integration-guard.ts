/**
 * qb-integration-guard.ts
 *
 * Single source of truth for the QB_INTEGRATION kill switch.
 *
 * The flag is stored in quickbooks_config.integration_enabled (DB).
 * It's also overridable via environment variable QB_INTEGRATION=false for
 * emergency shutdowns without a DB update.
 *
 * Usage in any core file:
 *   import { isQbIntegrationEnabled } from "./qb-integration-guard"
 *   if (!(await isQbIntegrationEnabled(client))) return { success: false, disabled: true }
 */

import { Client } from "pg";

let cachedEnabled: boolean | null = null;
let cacheExpiresAt: number = 0;
const CACHE_TTL_MS = 30_000; // re-check DB at most every 30 seconds

/**
 * Returns true if the QuickBooks integration is globally enabled.
 * Checks (in priority order):
 *   1. QB_INTEGRATION env var (emergency override: "false" to disable immediately)
 *   2. quickbooks_config.integration_enabled in the database
 *   3. Defaults to true if DB is unreachable (fail-open so syncs don't silently break)
 */
export async function isQbIntegrationEnabled(): Promise<boolean> {
  // Hard env-var override — fastest check, no DB needed
  if (process.env.QB_INTEGRATION === "false") return false;
  if (process.env.QB_INTEGRATION === "true") return true;

  // Cache to avoid hammering DB on every request
  if (cachedEnabled !== null && Date.now() < cacheExpiresAt) {
    return cachedEnabled;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(`
            SELECT integration_enabled FROM quickbooks_config WHERE id = 'default'
        `);
    const enabled = result.rows[0]?.integration_enabled ?? true;
    cachedEnabled = enabled;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return enabled;
  } catch {
    // If DB unreachable, fail-open (don't silently disable syncs)
    return cachedEnabled ?? true;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Call this after toggling the DB value to invalidate the in-process cache. */
export function invalidateQbIntegrationCache(): void {
  cachedEnabled = null;
  cacheExpiresAt = 0;
}
