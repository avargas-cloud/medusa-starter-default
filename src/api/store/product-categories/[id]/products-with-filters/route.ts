import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { enrichProducts } from "../../../_shared/product-enrichment";
import { getCacheManager } from "../../../../../lib/cache-manager";

/**
 * GET /store/categories/:id/products-with-filters
 *
 * Combined endpoint that returns:
 * - Paginated products (with prices + attributes)
 * - Pre-calculated filters from metadata
 *
 * Respects category.metadata.include_descendants_tree setting
 *
 * CACHING: Results are cached for 5 minutes per category+pagination combination
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "id required" });
    }
    const { limit = 20, offset = 0 } = req.query;

    // 🔥 CACHE LAYER: Check cache first
    const cacheKey = `category:${id}:products-filters:${limit}:${offset}`;
    const cacheService = req.scope.resolve("cache");
    const cacheManager = getCacheManager(cacheService);

    const cached = await cacheManager.get<any>(cacheKey);
    if (cached) {
      console.log(`[PRODUCTS-WITH-FILTERS] 🎯 Cache HIT: ${cacheKey}`);
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    console.log(`[PRODUCTS-WITH-FILTERS] ❌ Cache MISS: ${cacheKey}`);
    res.setHeader("X-Cache", "MISS");

    const query = req.scope.resolve("query");

    console.log(`\n[PRODUCTS-WITH-FILTERS] 📦 Fetching for category: ${id}`);
    console.log(
      `[PRODUCTS-WITH-FILTERS] 📄 Pagination: limit=${limit}, offset=${offset}`
    );

    // 1. Get category info (includes metadata)
    const { data: categories } = await query.graph({
      entity: "product_category",
      filters: { id },
      fields: ["id", "name", "handle", "parent_category_id", "metadata"],
    });

    if (!categories || categories.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    const category = categories[0]!;
    const includeDescendants =
      category.metadata?.include_descendants_tree ?? true;

    console.log(
      `[PRODUCTS-WITH-FILTERS] 🌳 include_descendants_tree: ${includeDescendants}`
    );

    // 2. Get descendant category IDs if needed
    let categoryIds = [id];
    if (includeDescendants) {
      const knex = req.scope.resolve("__pg_connection__");
      const descendants = await getCategoryDescendants(id, knex);
      categoryIds = [id, ...descendants];
      console.log(
        `[PRODUCTS-WITH-FILTERS] 👨‍👩‍👧‍👦 Including ${descendants.length} descendant categories`
      );
    }

    // 3. Build product query filters
    const productFilters: any = {
      status: "published",
      categories: { id: categoryIds },
    };

    // 4. Get total count using direct SQL (faster than query.graph)
    const knex = req.scope.resolve("__pg_connection__");

    const countResult = await knex("product")
      .join(
        "product_category_product",
        "product.id",
        "product_category_product.product_id"
      )
      .whereIn("product_category_product.product_category_id", categoryIds)
      .where("product.status", "published")
      .whereNull("product.deleted_at")
      .countDistinct("product.id as count")
      .first();

    const totalCount = parseInt(String(countResult?.count || "0"));

    // 5. Query paginated products
    const { data: paginatedProducts } = await query.graph({
      entity: "product",
      filters: productFilters,
      fields: ["*", "variants.*"],
      pagination: { skip: Number(offset), take: Number(limit) },
    });

    console.log(
      `[PRODUCTS-WITH-FILTERS] 📦 Found ${totalCount} total products, returning ${paginatedProducts.length}`
    );

    // 6. Enrich paginated products (prices + attributes)
    const enrichedProducts = await enrichProducts(paginatedProducts, req);

    // 7. Get pre-calculated filters from metadata
    const preCalculatedFilters = (category.metadata?.filters || []) as any[];

    console.log(
      `[PRODUCTS-WITH-FILTERS] 📊 Using ${preCalculatedFilters.length} pre-calculated filters`
    );

    // 8. Build response object
    const responseData = {
      category: {
        id: category.id,
        name: category.name,
        handle: category.handle,
        parent_category_id: category.parent_category_id,
        include_descendants_tree: includeDescendants,
      },
      products: enrichedProducts,
      filters: preCalculatedFilters,
      pagination: {
        total: totalCount,
        limit: Number(limit),
        offset: Number(offset),
        has_more: Number(offset) + enrichedProducts.length < totalCount,
      },
    };

    // 🔥 CACHE: Store result for 5 minutes
    await cacheManager.set(cacheKey, responseData, 300);
    console.log(`[PRODUCTS-WITH-FILTERS] 💾 Cached result: ${cacheKey}`);

    return res.json(responseData);
  } catch (error: any) {
    console.error(
      "[PRODUCTS-WITH-FILTERS] ❌ Error:",
      (error as Error).message
    );
    return res.status(500).json({ error: (error as Error).message });
  }
};

/**
 * Get all descendant category IDs using PostgreSQL recursive CTE
 * Single efficient query instead of N recursive queries
 */
async function getCategoryDescendants(
  categoryId: string,
  knex: any
): Promise<string[]> {
  const result = await knex.raw(
    `
        WITH RECURSIVE descendants AS (
            -- Base: direct children
            SELECT id
            FROM product_category
            WHERE parent_category_id = ?
              AND deleted_at IS NULL
            
            UNION
            
            -- Recursive: children of children
            SELECT pc.id
            FROM product_category pc
            INNER JOIN descendants d ON pc.parent_category_id = d.id
            WHERE pc.deleted_at IS NULL
        )
        SELECT id FROM descendants;
    `,
    [categoryId]
  );

  return result.rows.map((row: any) => row.id);
}
