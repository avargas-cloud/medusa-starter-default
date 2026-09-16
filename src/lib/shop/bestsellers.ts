/**
 * Shop bestsellers — cuenta órdenes distintas de los últimos N meses por
 * producto PUBLICADO, sumando las ventas de sus ALTERNATIVOS (`product_alternative`)
 * a la cuenta del producto primario. El resultado se persiste en
 * `product.metadata.orders_12m` (job `shop-bestsellers`, `src/jobs/shop-bestsellers.ts`).
 *
 * `computeOrders12m` NUNCA muta nada; `writeOrders12m` es el único escritor y
 * hace read-modify-write vía `metadata = COALESCE(metadata,'{}'::jsonb) || …`
 * (merge de claves top-level, nunca reemplazo del JSONB entero — regla de la casa).
 */
import type { Pool } from "pg";

export interface Orders12mCounts {
  orders: number;
  own: number;
  viaAlt: number;
}

export interface WriteOrders12mResult {
  updated: number;
}

const DEFAULT_MONTHS = 12;

/**
 * Cuenta, por cada producto `status='published' AND deleted_at IS NULL`,
 * las órdenes DISTINTAS de los últimos `opts.months` (default 12) que
 * incluyen una línea del producto MISMO ("own") o de alguno de sus
 * alternativos activos ("via alt", `product_alternative.alt_variant_id`
 * → `primary_variant_id.product_id`). El total es la UNIÓN (COUNT DISTINCT
 * por orden), así que una misma orden que trae el producto y su alterno no
 * se cuenta dos veces, y un ciclo A→B / B→A tampoco duplica.
 *
 * Todo producto publicado aparece en el mapa devuelto, incluso con 0 ventas
 * — así `writeOrders12m` puede bajar a 0 el metadata de un producto que
 * dejó de venderse.
 */
export async function computeOrders12m(
  pool: Pool,
  opts?: { months?: number }
): Promise<Map<string, Orders12mCounts>> {
  const months = opts?.months ?? DEFAULT_MONTHS;

  const result = await pool.query<{
    product_id: string;
    orders_total: string;
    orders_own: string;
    orders_via_alt: string;
  }>(
    `
    WITH alt AS (
      SELECT pa.alt_variant_id AS v, v1.product_id AS primary_product
      FROM product_alternative pa
      JOIN product_variant v1 ON v1.id = pa.primary_variant_id
      WHERE pa.deleted_at IS NULL AND pa.is_active
    ),
    sales AS (
      SELECT pv.product_id AS own_pid, alt.primary_product AS alt_pid, o.id AS oid
      FROM order_item oi
      JOIN order_line_item oli ON oli.id = oi.item_id
      JOIN "order" o ON o.id = oi.order_id
      JOIN product_variant pv ON pv.id = oli.variant_id
      LEFT JOIN alt ON alt.v = pv.id
      WHERE o.created_at >= now() - ($1::int || ' months')::interval
        AND o.deleted_at IS NULL
        AND oi.deleted_at IS NULL
    ),
    own_orders AS (
      SELECT DISTINCT own_pid AS product_id, oid FROM sales
    ),
    alt_orders AS (
      SELECT DISTINCT alt_pid AS product_id, oid
      FROM sales
      WHERE alt_pid IS NOT NULL AND alt_pid <> own_pid
    ),
    own_counts AS (
      SELECT product_id, COUNT(DISTINCT oid) AS own
      FROM own_orders
      GROUP BY product_id
    ),
    alt_counts AS (
      SELECT product_id, COUNT(DISTINCT oid) AS via_alt
      FROM alt_orders
      GROUP BY product_id
    ),
    total_counts AS (
      SELECT product_id, COUNT(DISTINCT oid) AS total
      FROM (
        SELECT product_id, oid FROM own_orders
        UNION
        SELECT product_id, oid FROM alt_orders
      ) u
      GROUP BY product_id
    )
    SELECT
      p.id AS product_id,
      COALESCE(t.total, 0) AS orders_total,
      COALESCE(o.own, 0) AS orders_own,
      COALESCE(a.via_alt, 0) AS orders_via_alt
    FROM product p
    LEFT JOIN total_counts t ON t.product_id = p.id
    LEFT JOIN own_counts o ON o.product_id = p.id
    LEFT JOIN alt_counts a ON a.product_id = p.id
    WHERE p.status = 'published' AND p.deleted_at IS NULL
    `,
    [months]
  );

  const out = new Map<string, Orders12mCounts>();
  for (const row of result.rows) {
    out.set(row.product_id, {
      orders: Number(row.orders_total),
      own: Number(row.orders_own),
      viaAlt: Number(row.orders_via_alt),
    });
  }
  return out;
}

/**
 * Persiste `orders_12m` (+ `orders_12m_at`) en `product.metadata` para cada
 * fila del mapa, UNA transacción, merge de claves top-level (nunca reemplazo
 * del JSONB entero). Sólo toca productos `status='published' AND deleted_at
 * IS NULL` — un producto que se volvió draft nunca lo pisa este writer.
 * Idempotente: devuelve cuántas filas cambiaron de VALOR (comparación
 * `IS DISTINCT FROM` contra el `orders_12m` previo), no cuántas se tocaron.
 */
/**
 * Posición de venta pública: 1 = más vendido, 0 = sin ventas en la ventana.
 * Es lo ÚNICO que sale por el Store API (allowlist en product-metadata/public-keys):
 * el orden sirve para el shop, el volumen (`orders_12m`) queda interno.
 */
export function salesRanks(rows: Map<string, Orders12mCounts>): Map<string, number> {
  const sold = [...rows.entries()]
    .filter(([, c]) => c.orders > 0)
    .sort((a, b) => b[1].orders - a[1].orders || a[0].localeCompare(b[0]));
  return new Map(sold.map(([id], i) => [id, i + 1]));
}

export async function writeOrders12m(
  pool: Pool,
  rows: Map<string, Orders12mCounts>
): Promise<WriteOrders12mResult> {
  const client = await pool.connect();
  const writtenAt = new Date().toISOString();
  const ranks = salesRanks(rows);
  let updated = 0;
  try {
    await client.query("BEGIN");
    for (const [productId, counts] of rows) {
      const salesRank = ranks.get(productId) ?? 0;
      const result = await client.query(
        `
        UPDATE product
           SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'orders_12m', $2::int,
                  'orders_12m_at', $3::text,
                  'shop_sales_rank', $4::int
                )
         WHERE id = $1
           AND status = 'published'
           AND deleted_at IS NULL
           AND (
             (metadata ->> 'orders_12m') IS DISTINCT FROM $2::text
             OR (metadata ->> 'shop_sales_rank') IS DISTINCT FROM $4::text
           )
        `,
        [productId, counts.orders, writtenAt, salesRank]
      );
      updated += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { updated };
}
