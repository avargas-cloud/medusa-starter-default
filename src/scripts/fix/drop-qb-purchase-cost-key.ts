/**
 * Phase 3 cleanup: remove the legacy `qb_purchase_cost` metadata key now that
 * everything reads/writes `purchase_cost`. Safety-copies any stragglers first,
 * then deletes the key with the jsonb `-` operator.
 *
 * NOTE: uses `metadata->>'k' IS NOT NULL` (NOT the jsonb `?` existence operator)
 * because knex.raw treats `?` as a bind placeholder (documented gotcha).
 *
 * Dry-run by default. Apply: APPLY=true npx medusa exec ./src/scripts/fix/drop-qb-purchase-cost-key.ts
 */
export default async function dropQbPurchaseCostKey({
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
    SELECT
      count(*) FILTER (WHERE metadata->>'qb_purchase_cost' IS NOT NULL)                                  AS has_legacy,
      count(*) FILTER (WHERE metadata->>'qb_purchase_cost' IS NOT NULL AND metadata->>'purchase_cost' IS NULL) AS needs_copy
    FROM product_variant WHERE deleted_at IS NULL`);
  const s = rows[0] ?? {};
  console.log(`Legacy qb_purchase_cost rows: ${s.has_legacy ?? 0} (of which ${s.needs_copy ?? 0} still need purchase_cost copied first)`);

  if (!apply) {
    console.log("DRY RUN — set APPLY=true to write. No changes made.");
    return { has_legacy: s.has_legacy ?? 0, dryRun: true };
  }

  // 1. Safety copy for any straggler (qb_purchase_cost set, purchase_cost unset).
  await pg.raw(`
    UPDATE product_variant
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('purchase_cost',
                           NULLIF(metadata->>'qb_purchase_cost', '')::numeric)
     WHERE deleted_at IS NULL
       AND metadata->>'qb_purchase_cost' IS NOT NULL
       AND metadata->>'purchase_cost' IS NULL`);

  // 2. Drop the legacy key.
  const res = await pg.raw(`
    UPDATE product_variant
       SET metadata = metadata - 'qb_purchase_cost', updated_at = NOW()
     WHERE deleted_at IS NULL
       AND metadata->>'qb_purchase_cost' IS NOT NULL`);
  console.log(`✅ Dropped qb_purchase_cost from ${res.rowCount ?? 0} variants.`);
  return { dropped: res.rowCount ?? 0, dryRun: false };
}
