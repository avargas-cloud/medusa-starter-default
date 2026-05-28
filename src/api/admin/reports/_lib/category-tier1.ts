/**
 * Maps each product to its Tier 1 category (direct child of the BY CATEGORIES root).
 *
 * Strategy:
 *  1. If product has `metadata.primary_category_id` → seed walk from that one category only.
 *  2. Else → seed walk from every `product_category_product` assignment.
 *  3. Recursively climb the parent chain (max 6 levels) until a category whose
 *     `parent_category_id` IS the root. That category's name/id is the Tier 1.
 *  4. Per product, prefer the shortest-path Tier 1 (depth ASC).
 *
 * Products whose category chain never reaches the root → no row in `product_tier1`.
 * Callers should `LEFT JOIN product_tier1 pt ON pt.product_id = p.id` and
 * `COALESCE(pt.category, 'Uncategorized')` at projection time.
 *
 * Exposes columns: `product_id`, `category_id`, `category` (name).
 *
 * Usage — prepend to your WITH clause and change `WITH` → `WITH RECURSIVE`:
 *
 *   pg.raw(`WITH RECURSIVE ${TIER1_CTE}, other_cte AS (...) SELECT ... LEFT JOIN product_tier1 pt ON pt.product_id = p.id`, [...])
 *
 * The ROOT_CAT id is interpolated literally (hardcoded constant, not user input → safe).
 */
export const TIER1_ROOT_CAT = "pcat_01KGAD1KQV29RKZZHEZ4N88B8H"

export const TIER1_CTE = `cat_ancestry AS (
  (
    SELECT
      p.id                       AS product_id,
      pc.id                      AS cat_id,
      pc.name                    AS cat_name,
      pc.parent_category_id,
      0                          AS depth
    FROM product p
    JOIN product_category pc ON pc.id = p.metadata->>'primary_category_id'
    WHERE p.deleted_at IS NULL AND p.metadata ? 'primary_category_id'
    UNION ALL
    SELECT
      pcp.product_id,
      pc.id,
      pc.name,
      pc.parent_category_id,
      0
    FROM product_category_product pcp
    JOIN product p ON p.id = pcp.product_id AND p.deleted_at IS NULL
                   AND NOT (p.metadata ? 'primary_category_id')
    JOIN product_category pc ON pc.id = pcp.product_category_id
  )
  UNION ALL
  SELECT
    ca.product_id,
    pc.id,
    pc.name,
    pc.parent_category_id,
    ca.depth + 1
  FROM cat_ancestry ca
  JOIN product_category pc ON pc.id = ca.parent_category_id
  WHERE ca.depth < 6
),
product_tier1 AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    cat_id   AS category_id,
    cat_name AS category
  FROM cat_ancestry
  WHERE parent_category_id = '${TIER1_ROOT_CAT}'
  ORDER BY product_id, depth ASC
)`
