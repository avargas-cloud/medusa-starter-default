/**
 * getPublishedProductCountsBySubtree — for every non-deleted product_category,
 * counts the DISTINCT published, non-deleted products reachable in its
 * subtree (the category itself plus all of its descendants, any depth).
 *
 * ONE recursive-CTE query, no per-category N+1. No parameters, so nothing to
 * bind — style otherwise matches the raw-SQL pattern used across
 * src/api/store/** (knex.raw with `?` placeholders; here there are none).
 */
export async function getPublishedProductCountsBySubtree(
  container: any
): Promise<Map<string, number>> {
  const knex = container.resolve("__pg_connection__");

  const result = await knex.raw(`
    WITH RECURSIVE subtree AS (
        -- Base: every category is its own subtree root
        SELECT id AS root_id, id AS category_id
        FROM product_category
        WHERE deleted_at IS NULL

        UNION ALL

        -- Recursive: pull descendants into their ancestor's subtree
        SELECT subtree.root_id, pc.id AS category_id
        FROM product_category pc
        INNER JOIN subtree ON pc.parent_category_id = subtree.category_id
        WHERE pc.deleted_at IS NULL
    )
    SELECT
        subtree.root_id AS category_id,
        COUNT(DISTINCT product.id) AS published_product_count
    FROM subtree
    LEFT JOIN product_category_product
        ON product_category_product.product_category_id = subtree.category_id
    LEFT JOIN product
        ON product.id = product_category_product.product_id
        AND product.status = 'published'
        AND product.deleted_at IS NULL
    GROUP BY subtree.root_id;
  `);

  const counts = new Map<string, number>();
  for (const row of result.rows as Array<{
    category_id: string;
    published_product_count: string | number;
  }>) {
    counts.set(row.category_id, Number(row.published_product_count));
  }

  return counts;
}
