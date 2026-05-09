import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * Snapshot data sourced from `product_variant.metadata.qb_avg_cost` and
 * `product_variant.metadata.qb_avg_cost_synced_at` (both written by
 * `lib/quickbooks/sync-average-cost-core.ts`).
 *
 * Either / both may be null:
 *   - `cost` null → variant has never been synced from QB or its qb_avg_cost
 *     is non-numeric / blank.
 *   - `synced_at` null → cost was synced before we started stamping the
 *     timestamp (legacy rows). Treat as "unknown freshness".
 */
export type VariantAvgCost = {
  cost: number | null;
  synced_at: Date | null;
};

/**
 * Batch-fetch average unit cost data for a set of product variants in a
 * single SQL round-trip, using raw pg connection.
 *
 * WHY RAW SQL: Medusa v2's `productModule.listProductVariants` does not
 * reliably hydrate the `metadata` JSONB column (same reason
 * src/api/admin/purchase-orders/[id]/route.ts uses raw queries — see comment
 * around line 350 there). Reading metadata directly is the proven path.
 *
 * Returns a Map keyed by variant_id. Variants that don't exist or whose
 * metadata fields are missing/malformed are returned as
 * `{ cost: null, synced_at: null }` (so callers can use a single uniform
 * lookup per item without null-coalescing).
 */
export async function getVariantAvgCostBatch(
  container: MedusaContainer,
  variantIds: readonly string[]
): Promise<Map<string, VariantAvgCost>> {
  const result = new Map<string, VariantAvgCost>();
  const unique = Array.from(new Set(variantIds.filter((id) => !!id)));
  if (unique.length === 0) return result;

  const pgConnection = container.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };

  const rows = await pgConnection.raw(
    `SELECT id,
            metadata->>'qb_avg_cost' AS qb_avg_cost,
            metadata->>'qb_avg_cost_synced_at' AS qb_avg_cost_synced_at
       FROM product_variant
      WHERE id = ANY(?)`,
    [unique]
  );

  for (const row of rows.rows) {
    const id = String(row.id);
    const cost = parseCost(row.qb_avg_cost);
    const syncedAt = parseSyncedAt(row.qb_avg_cost_synced_at);
    result.set(id, { cost, synced_at: syncedAt });
  }

  // Variants not found in the result still get a uniform entry so callers
  // can rely on `result.get(id) ?? { cost: null, synced_at: null }` semantics.
  for (const id of unique) {
    if (!result.has(id)) {
      result.set(id, { cost: null, synced_at: null });
    }
  }

  return result;
}

function parseCost(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseSyncedAt(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) return raw;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}
