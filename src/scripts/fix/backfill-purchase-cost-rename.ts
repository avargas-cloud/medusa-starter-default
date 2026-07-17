/**
 * Phase 3 rename: copy `product_variant.metadata.qb_purchase_cost` →
 * `purchase_cost` (drops the "qb" prefix). Transition-safe: both keys coexist;
 * readers COALESCE(purchase_cost, qb_purchase_cost) and writers write both, so
 * a missed callsite still resolves. A later cleanup drops qb_purchase_cost.
 *
 * Idempotent: only fills rows where purchase_cost is not already set.
 * Dry-run by default. Apply: APPLY=true npx medusa exec ./src/scripts/fix/backfill-purchase-cost-rename.ts
 */
export default async function backfillPurchaseCostRename({
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

  const { rows } = await pg.raw(`
    SELECT count(*)::int AS n
      FROM product_variant
     WHERE deleted_at IS NULL
       AND NULLIF(metadata->>'qb_purchase_cost', '') IS NOT NULL
       AND (metadata->>'purchase_cost') IS NULL`);
  const eligible = rows[0]?.n ?? 0;
  console.log(`Eligible variants (qb_purchase_cost set, purchase_cost unset): ${eligible}`);

  if (!apply) {
    console.log("DRY RUN — set APPLY=true to write. No changes made.");
    return { eligible, applied: 0, dryRun: true };
  }

  const res = await pg.raw(`
    UPDATE product_variant
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('purchase_cost',
                           NULLIF(metadata->>'qb_purchase_cost', '')::numeric),
           updated_at = NOW()
     WHERE deleted_at IS NULL
       AND NULLIF(metadata->>'qb_purchase_cost', '') IS NOT NULL
       AND (metadata->>'purchase_cost') IS NULL`);
  console.log(`✅ Copied qb_purchase_cost → purchase_cost on ${res.rowCount ?? 0} variants.`);
  return { eligible, applied: res.rowCount ?? 0, dryRun: false };
}
