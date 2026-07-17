/**
 * Exercises getVariantAvgCostBatch (the invoice/CM cost snapshot resolver) for
 * a China (landed) SKU and a purchase-fallback SKU — proves Phase 1 reads the
 * canonical `average_cost` first with the right source.
 *   npx medusa exec ./src/scripts/checks/check-average-cost-resolver.ts
 */
import { getVariantAvgCostBatch } from "../../lib/cost/get-variant-avg-cost";

export default async function check({ container }: { container: any }) {
  const pg = container.resolve("__pg_connection__");
  const { rows } = await pg.raw(
    `SELECT pv.id, pv.sku, pv.metadata->>'average_cost_source' AS src
       FROM product_variant pv
      WHERE pv.deleted_at IS NULL
        AND pv.metadata->>'average_cost' IS NOT NULL
        AND pv.metadata->>'average_cost_source' IN ('landed','sync','purchase')
      ORDER BY pv.metadata->>'average_cost_source', pv.sku
      LIMIT 60`
  );
  // one representative per source
  const bySrc: Record<string, any> = {};
  for (const r of rows) if (!bySrc[r.src]) bySrc[r.src] = r;
  const picks = Object.values(bySrc) as any[];

  const resolved = await getVariantAvgCostBatch(
    container,
    picks.map((p) => p.id)
  );
  for (const p of picks) {
    const r = resolved.get(p.id);
    console.log(
      `${p.sku} (stored source=${p.src}) → cost=${r?.cost} source=${r?.source} synced_at=${r?.synced_at?.toISOString?.() ?? r?.synced_at}`
    );
  }
  return { checked: picks.length };
}
