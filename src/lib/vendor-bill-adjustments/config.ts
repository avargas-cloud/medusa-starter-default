/**
 * src/lib/vendor-bill-adjustments/config.ts
 *
 * Accounts and tolerance of the AP adjustment lane, kept in `store.metadata`
 * like the AR rounding lane (`lib/rounding/config.ts`). Fail-closed: with a
 * missing account nothing is written — a residual left open is a visible
 * problem, an adjustment against the wrong account is an invisible one.
 *
 *   qb_ap_rounding_account            ListID — `kind = rounding`
 *   qb_purchase_price_variance_account ListID — `kind = price_variance`
 *   ap_rounding_tolerance_cents        integer, default 50 (absolute, never a %)
 */
import { getDbPool } from "../../api/utils/db-pool";

export const AP_ADJUSTMENT_CONFIG_KEYS = {
  rounding: "qb_ap_rounding_account",
  priceVariance: "qb_purchase_price_variance_account",
  tolerance: "ap_rounding_tolerance_cents",
} as const;

export const DEFAULT_AP_ROUNDING_TOLERANCE_CENTS = 50;

export interface ApAdjustmentConfig {
  roundingAccountListId: string | null;
  priceVarianceAccountListId: string | null;
  toleranceCents: number;
}

type QueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function clean(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

export function parseTolerance(raw: unknown): number {
  const n =
    typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  // Bounded on purpose: the tolerance is what keeps this lane from becoming a
  // write-off of anything — 1000¢ ($10) is already generous.
  if (!Number.isInteger(n) || n < 0 || n > 1000)
    return DEFAULT_AP_ROUNDING_TOLERANCE_CENTS;
  return n;
}

export async function loadApAdjustmentConfig(
  client?: QueryClient
): Promise<ApAdjustmentConfig> {
  const q = client ?? getDbPool();
  const { rows } = await q.query(
    `SELECT metadata->>'${AP_ADJUSTMENT_CONFIG_KEYS.rounding}' AS rounding,
            metadata->>'${AP_ADJUSTMENT_CONFIG_KEYS.priceVariance}' AS variance,
            metadata->>'${AP_ADJUSTMENT_CONFIG_KEYS.tolerance}' AS tolerance
       FROM store LIMIT 1`
  );
  const r = (rows[0] ?? {}) as {
    rounding?: unknown;
    variance?: unknown;
    tolerance?: unknown;
  };
  return {
    roundingAccountListId: clean(r.rounding),
    priceVarianceAccountListId: clean(r.variance),
    toleranceCents: parseTolerance(r.tolerance),
  };
}
