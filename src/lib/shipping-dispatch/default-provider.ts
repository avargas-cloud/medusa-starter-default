/**
 * src/lib/shipping-dispatch/default-provider.ts
 *
 * Which dispatch provider backs label creation when the request doesn't say —
 * admin-selectable via system_defaults (context='shipping',
 * field_name='dispatch_provider', value='shippo'|'ups'|...), same mechanism as
 * the PO status options. Missing row → 'shippo'. An admin picking a provider
 * that isn't built/configured yet fails downstream with a clean
 * not_configured (the registry guards), never a silent fallback.
 */

import type { Pool } from "pg";

export async function resolveDispatchProvider(
  pool: Pool,
  explicit?: string | null
): Promise<string> {
  if (explicit) return explicit;
  try {
    const { rows } = await pool.query<{ value: string | null }>(
      `SELECT value FROM system_defaults
        WHERE context = 'shipping' AND field_name = 'dispatch_provider'
        ORDER BY sort_order ASC LIMIT 1`
    );
    const v = rows[0]?.value?.trim().toLowerCase();
    return v || "shippo";
  } catch {
    return "shippo";
  }
}
