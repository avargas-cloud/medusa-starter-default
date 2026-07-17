/**
 * Backfill `product_variant.metadata.avg_landed_cost_updated_at` for variants
 * that already carry an `avg_landed_cost_cents` but predate the timestamp
 * (added 2026-07-17). Value = latest ACTIVE (reversed_at IS NULL) vendor-bill
 * cost-log entry per variant — the last time the landed AVCO actually moved.
 *
 * Freshness provenance for China lines (getVariantAvgCostBatch reads it). Rows
 * with a landed cost but no cost-log (e.g. seeded/imported) stay null.
 *
 * Dry-run by default. Apply: APPLY=true npx medusa exec ./src/scripts/fix/backfill-landed-cost-updated-at.ts
 */
export default async function backfillLandedCostUpdatedAt({
  container,
}: {
  container: {
    resolve: (k: string) => {
      raw: (sql: string, b?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
    };
  };
}) {
  const pg = container.resolve("__pg_connection__");
  const apply = process.env.APPLY === "true";

  const { rows: elig } = await pg.raw(`
    SELECT count(*)::int AS n
      FROM product_variant pv
      JOIN (SELECT product_variant_id, MAX(created_at) AS ts
              FROM vendor_bill_cost_log
             WHERE reversed_at IS NULL
             GROUP BY product_variant_id) l ON l.product_variant_id = pv.id
     WHERE pv.deleted_at IS NULL
       AND (pv.metadata->>'avg_landed_cost_cents') IS NOT NULL
       AND (pv.metadata->>'average_cost_updated_at') IS NULL`);
  const eligible = elig[0]?.n ?? 0;
  console.log(`Eligible variants (landed cost, no timestamp, has active log): ${eligible}`);

  if (!apply) {
    console.log("DRY RUN — set APPLY=true to write. No changes made.");
    return { eligible, applied: 0, dryRun: true };
  }

  const res = await pg.raw(`
    WITH latest AS (
      SELECT product_variant_id, MAX(created_at) AS ts
        FROM vendor_bill_cost_log
       WHERE reversed_at IS NULL
       GROUP BY product_variant_id
    )
    UPDATE product_variant pv
       SET metadata = COALESCE(pv.metadata, '{}'::jsonb)
                      || jsonb_build_object('avg_landed_cost_updated_at', l.ts::text,
                                            'average_cost_updated_at', l.ts::text),
           updated_at = NOW()
      FROM latest l
     WHERE pv.id = l.product_variant_id
       AND pv.deleted_at IS NULL
       AND (pv.metadata->>'avg_landed_cost_cents') IS NOT NULL
       AND (pv.metadata->>'average_cost_updated_at') IS NULL`);

  console.log(`✅ Applied landed-cost freshness timestamps to ${res.rowCount ?? 0} variants.`);
  return { eligible, applied: res.rowCount ?? 0, dryRun: false };
}
