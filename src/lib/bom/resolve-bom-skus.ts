import type { Pool, PoolClient } from "pg";

export type BomDb = Pick<Pool | PoolClient, "query">;

export interface ResolvedVariant {
  variantId: string;
  sku: string;
}

/**
 * SKU → variante VENDIBLE en la web: producto publicado, no borrado y —si el
 * carrito tiene canal— asociado a ese sales channel. Un SKU que existe pero
 * no está publicado NO se resuelve: la web no puede vender lo que no muestra,
 * y `addToCartWorkflow` lo rechazaría igual, con un error menos claro.
 * Los componentes que un BOM necesita (módulos, lever nuts, conectores) se
 * PUBLICAN en Medusa (user-stated 2026-09-11) — no se relaja este filtro.
 *
 * Match exacto primero; si no, insensible a mayúsculas (los SKUs de las apps
 * salen del mismo catálogo, pero un catálogo viejo puede traerlos en otra
 * caja). Devuelve un mapa sku-pedido → variante.
 */
export async function resolveBomSkus(
  db: BomDb,
  skus: string[],
  salesChannelId: string | null
): Promise<Map<string, ResolvedVariant>> {
  const resolved = new Map<string, ResolvedVariant>();
  if (skus.length === 0) return resolved;
  const wanted = [...new Set(skus)];
  const res = await db.query<{ id: string; sku: string }>(
    `SELECT pv.id, pv.sku
       FROM product_variant pv
       JOIN product p
         ON p.id = pv.product_id
        AND p.deleted_at IS NULL
        AND p.status = 'published'
      WHERE pv.deleted_at IS NULL
        AND pv.sku IS NOT NULL
        AND lower(pv.sku) = ANY($1::text[])
        AND (
          $2::text IS NULL
          OR EXISTS (
            SELECT 1 FROM product_sales_channel psc
             WHERE psc.product_id = p.id
               AND psc.sales_channel_id = $2::text
               AND psc.deleted_at IS NULL
          )
        )`,
    [wanted.map((s) => s.toLowerCase()), salesChannelId]
  );
  const byLower = new Map<string, ResolvedVariant[]>();
  for (const row of res.rows) {
    const key = row.sku.toLowerCase();
    const list = byLower.get(key) ?? [];
    list.push({ variantId: row.id, sku: row.sku });
    byLower.set(key, list);
  }
  for (const sku of wanted) {
    const candidates = byLower.get(sku.toLowerCase()) ?? [];
    const exact = candidates.find((c) => c.sku === sku);
    const pick = exact ?? candidates[0];
    if (pick) resolved.set(sku, pick);
  }
  return resolved;
}
