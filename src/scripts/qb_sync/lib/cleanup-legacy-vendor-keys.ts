/**
 * One-shot cleanup of legacy vendor keys in variant.metadata after the
 * mass metadata sync establishes the canonical representation
 * (product.metadata defaults + variant.metadata overrides + link table).
 *
 * Removes: qb_vendor_id, qb_vendor_name (written by old mass-cost-sync.ts).
 * Preserves every other key.
 */
import type { MedusaContainer } from "@medusajs/framework/types";

export type LegacyCleanupReport = {
  variantsScanned: number;
  variantsUpdated: number;
};

export async function cleanupLegacyVendorKeys(
  container: MedusaContainer,
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<LegacyCleanupReport> {
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  };

  const scanSql = `
    SELECT COUNT(*)::int AS n
      FROM product_variant
     WHERE deleted_at IS NULL
       AND (metadata ? 'qb_vendor_id' OR metadata ? 'qb_vendor_name')
  `;
  const scan = await knex.raw(scanSql);
  const variantsScanned = Number((scan.rows[0] as { n?: number } | undefined)?.n ?? 0);

  if (opts.dryRun) {
    return { variantsScanned, variantsUpdated: 0 };
  }

  const updateSql = `
    UPDATE product_variant
       SET metadata = (metadata - 'qb_vendor_id' - 'qb_vendor_name'),
           updated_at = NOW()
     WHERE deleted_at IS NULL
       AND (metadata ? 'qb_vendor_id' OR metadata ? 'qb_vendor_name')
  `;
  const res = await knex.raw(updateSql);
  return { variantsScanned, variantsUpdated: res.rowCount };
}
