/**
 * Backfill the canonical `product_variant.metadata.average_cost` (dollars) +
 * `average_cost_source` + `average_cost_updated_at` from the legacy per-origin
 * fields. Phase 1 of the cost-field convergence.
 *
 * Origin-aware (NOT a flat COALESCE):
 *   • China (is_sourced_via_agent):
 *       avg_landed_cost_cents > 0 → landed/100     (source 'landed')
 *       else qb_purchase_cost               → purchase (source 'purchase')
 *   • USA / local:
 *       qb_avg_cost present          → qb_avg_cost   (source 'sync')
 *       else qb_purchase_cost               → purchase (source 'purchase')
 * A USA variant that also has a landed cost MUST keep QuickBooks avg (QB is
 * authoritative for USA). Values <= 0 for the landed path are treated as absent.
 *
 * Idempotent: only fills rows where `average_cost` is not already set.
 * Dry-run by default. Apply: APPLY=true npx medusa exec ./src/scripts/fix/backfill-average-cost.ts
 */
export default async function backfillAverageCost({
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

  const computed = `
    WITH src AS (
      SELECT pv.id,
        -- COALESCE to false: a product without the key yields (NULL='true')=NULL,
        -- and NOT-of-NULL is NULL, so the non-China CASE branches would never match.
        COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false) AS is_china,
        NULLIF(pv.metadata->>'avg_landed_cost_cents','')::numeric      AS landed_cents,
        NULLIF(pv.metadata->>'qb_avg_cost','')::numeric                AS qb_avg,
        NULLIF(pv.metadata->>'qb_purchase_cost','')::numeric           AS purchase,
        pv.metadata->>'avg_landed_cost_updated_at'                     AS landed_at,
        pv.metadata->>'qb_avg_cost_synced_at'                          AS qb_at
      FROM product_variant pv
      LEFT JOIN product p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL
        AND (pv.metadata->>'average_cost') IS NULL
    )
    SELECT id,
      CASE WHEN is_china AND landed_cents > 0 THEN landed_cents / 100.0
           WHEN is_china AND purchase IS NOT NULL THEN purchase
           WHEN NOT is_china AND qb_avg IS NOT NULL THEN qb_avg
           WHEN purchase IS NOT NULL THEN purchase
           ELSE NULL END AS val,
      CASE WHEN is_china AND landed_cents > 0 THEN 'landed'
           WHEN NOT is_china AND qb_avg IS NOT NULL THEN 'sync'
           WHEN purchase IS NOT NULL THEN 'purchase'
           ELSE NULL END AS src,
      CASE WHEN is_china AND landed_cents > 0 THEN landed_at
           WHEN NOT is_china AND qb_avg IS NOT NULL THEN qb_at
           ELSE NULL END AS ts
    FROM src`;

  const { rows } = await pg.raw(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE src='landed')::int AS landed,
            count(*) FILTER (WHERE src='sync')::int AS sync,
            count(*) FILTER (WHERE src='purchase')::int AS purchase
       FROM (${computed}) c WHERE c.val IS NOT NULL`
  );
  const stats = rows[0] ?? {};
  console.log(
    `Eligible: ${stats.n ?? 0} (landed ${stats.landed ?? 0} · sync ${stats.sync ?? 0} · purchase ${stats.purchase ?? 0})`
  );

  if (!apply) {
    console.log("DRY RUN — set APPLY=true to write. No changes made.");
    return { eligible: stats.n ?? 0, applied: 0, dryRun: true };
  }

  const res = await pg.raw(
    `UPDATE product_variant pv
        SET metadata = COALESCE(pv.metadata, '{}'::jsonb)
                       || jsonb_strip_nulls(jsonb_build_object(
                            'average_cost', c.val,
                            'average_cost_source', c.src,
                            'average_cost_updated_at', c.ts)),
            updated_at = NOW()
       FROM (${computed}) c
      WHERE pv.id = c.id AND c.val IS NOT NULL`
  );
  console.log(`✅ Applied average_cost to ${res.rowCount ?? 0} variants.`);
  return { eligible: stats.n ?? 0, applied: res.rowCount ?? 0, dryRun: false };
}
