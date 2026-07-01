/**
 * Shared query for China Inventory Adjustment line data.
 *
 * Resolves, for China-sourced products (product.metadata.is_sourced_via_agent),
 * the current China warehouse figures used by the adjustment UI:
 *   - china_stock : GREATEST(0, stocked − reserved)  (== the Meili `chinaStock`
 *                   "available" figure the operator sees)
 *   - committed   : units reserved by CONFIRMED (not yet shipped) transfers —
 *                   physically STILL in China (the agent counts these).
 *   - in_transit  : units reserved by SHIPPED transfers — already left China,
 *                   not yet received in the USA (the agent does NOT count these).
 *
 * `committed`/`in_transit` are raw reservation sums (no GREATEST cap): if
 * reservation state exceeds visible stock that is useful signal, not noise.
 */
import { CHINA_LOC } from "../../../../lib/locations";

export interface KnexRaw {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

export interface ChinaProductLine {
  inventory_item_id: string;
  sku: string;
  title: string;
  china_stock: number;
  committed: number;
  in_transit: number;
}

interface Filter {
  /** Free-text typeahead over sku + title (ILIKE %q%). */
  q?: string;
  /** SKU prefixes — each matched as `sku ILIKE 'PREFIX%'`. */
  prefixes?: string[];
  /** Restrict to a set of inventory_item_ids (used to enrich existing lines). */
  inventoryItemIds?: string[];
  limit?: number;
}

/**
 * Returns China-sourced variant lines with live China stock / committed /
 * in-transit figures. Only products flagged `is_sourced_via_agent = true`.
 */
export async function loadChinaProductLines(
  knex: KnexRaw,
  filter: Filter
): Promise<ChinaProductLine[]> {
  const where: string[] = [
    `p.deleted_at IS NULL`,
    `pv.deleted_at IS NULL`,
    `pvii.deleted_at IS NULL`,
    `COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) = true`,
    `pv.sku IS NOT NULL AND pv.sku <> ''`,
  ];
  const bindings: unknown[] = [];

  if (filter.q && filter.q.trim()) {
    where.push(`(pv.sku ILIKE ? OR p.title ILIKE ?)`);
    bindings.push(`%${filter.q.trim()}%`, `%${filter.q.trim()}%`);
  }
  if (filter.prefixes && filter.prefixes.length > 0) {
    const patterns = filter.prefixes.map((p) => `${p}%`);
    where.push(`pv.sku ILIKE ANY(?)`);
    bindings.push(patterns);
  }
  if (filter.inventoryItemIds && filter.inventoryItemIds.length > 0) {
    where.push(`pvii.inventory_item_id = ANY(?)`);
    bindings.push(filter.inventoryItemIds);
  }

  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 5000);

  const reservedCte = (status: string) =>
    `SELECT ri.inventory_item_id, SUM(ri.quantity)::int AS qty
       FROM reservation_item ri
       JOIN inventory_transfer it ON it.id = ri.metadata->>'inventory_transfer_id'
        AND it.deleted_at IS NULL
      WHERE ri.deleted_at IS NULL
        AND ri.location_id = ?
        AND ri.metadata->>'source' = 'inventory_transfer'
        AND it.origin_country = 'CN'
        AND it.status = '${status}'
      GROUP BY ri.inventory_item_id`;

  // CHINA_LOC bound three times, in SQL order: committed CTE, in_transit CTE,
  // then the inventory_level join. WHERE bindings follow.
  const result = await knex.raw(
    `WITH committed AS (${reservedCte("confirmed")}),
          in_transit AS (${reservedCte("shipped")})
     SELECT pvii.inventory_item_id,
            pv.sku,
            p.title,
            GREATEST(0, COALESCE(il.stocked_quantity, 0) - COALESCE(il.reserved_quantity, 0)) AS china_stock,
            COALESCE(c.qty, 0)  AS committed,
            COALESCE(t.qty, 0)  AS in_transit
       FROM product p
       JOIN product_variant pv ON pv.product_id = p.id
       JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
       LEFT JOIN inventory_level il ON il.inventory_item_id = pvii.inventory_item_id
         AND il.location_id = ? AND il.deleted_at IS NULL
       LEFT JOIN committed  c ON c.inventory_item_id = pvii.inventory_item_id
       LEFT JOIN in_transit t ON t.inventory_item_id = pvii.inventory_item_id
      WHERE ${where.join(" AND ")}
      ORDER BY pv.sku ASC
      LIMIT ${limit}`,
    [CHINA_LOC, CHINA_LOC, CHINA_LOC, ...bindings]
  );

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    inventory_item_id: String(r.inventory_item_id),
    sku: String(r.sku),
    title: String(r.title ?? ""),
    china_stock: Number(r.china_stock ?? 0),
    committed: Number(r.committed ?? 0),
    in_transit: Number(r.in_transit ?? 0),
  }));
}

export interface ReservedByStatus {
  committed: number;
  in_transit: number;
}

/**
 * Lightweight lookup of China reservation units split by transfer status, keyed
 * by inventory_item_id. Unlike loadChinaProductLines this does NOT filter to
 * China-sourced products — it answers "how much of THIS item is committed vs in
 * transit" for any set of items (used by the Inventory China page).
 */
export async function loadChinaReservedByItem(
  knex: KnexRaw,
  inventoryItemIds: string[]
): Promise<Map<string, ReservedByStatus>> {
  const map = new Map<string, ReservedByStatus>();
  const ids = Array.from(new Set(inventoryItemIds)).filter(Boolean);
  if (ids.length === 0) return map;

  const result = await knex.raw(
    `SELECT ri.inventory_item_id,
            SUM(ri.quantity) FILTER (WHERE it.status = 'confirmed')::int AS committed,
            SUM(ri.quantity) FILTER (WHERE it.status = 'shipped')::int   AS in_transit
       FROM reservation_item ri
       JOIN inventory_transfer it ON it.id = ri.metadata->>'inventory_transfer_id'
        AND it.deleted_at IS NULL
      WHERE ri.deleted_at IS NULL
        AND ri.location_id = ?
        AND ri.metadata->>'source' = 'inventory_transfer'
        AND it.origin_country = 'CN'
        AND it.status IN ('confirmed', 'shipped')
        AND ri.inventory_item_id = ANY(?)
      GROUP BY ri.inventory_item_id`,
    [CHINA_LOC, ids]
  );

  for (const row of result.rows as Array<Record<string, unknown>>) {
    map.set(String(row.inventory_item_id), {
      committed: Number(row.committed ?? 0),
      in_transit: Number(row.in_transit ?? 0),
    });
  }
  return map;
}
