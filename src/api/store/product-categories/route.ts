import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getPublishedProductCountsBySubtree } from "../../../lib/catalog/category-published-counts";

/**
 * GET /store/product-categories
 *
 * Custom list endpoint that adds breadcrumbs to each category.
 * Handles filtering by handle, name, etc.
 *
 * Storefront-safety defaults (unless overridden by the caller):
 * - is_active: true, is_internal: false (always).
 * - category_children with zero published products in their subtree are
 *   dropped (always). The category itself is
 *   never dropped from product_categories; every entry gets
 *   published_product_count so the storefront can decide at the top level.
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query");

  try {
    // Storefront-only route: inactive/internal categories are never exposed (Medusa's store
  // query validator rejects unknown params, so there is deliberately no opt-in switch).
  const includeInactive = false;
    const includeEmpty = false;

    // Build filters from query params
    const filters: any = {};
    if (req.query.handle) filters.handle = req.query.handle;
    if (req.query.name) filters.name = req.query.name;
    if (!includeInactive) {
      filters.is_active = true;
      filters.is_internal = false;
    }

    // parent_category_id: Medusa core passes null as literal "null" string from URL
    const rawParentId = req.query.parent_category_id;
    if (rawParentId !== undefined) {
      filters.parent_category_id = rawParentId === "null" ? null : rawParentId;
    }

    // Get categories using query.graph with explicit fields
    const { data: categories } = await query.graph({
      entity: "product_category",
      fields: [
        "id",
        "name",
        "handle",
        "description",
        "parent_category_id",
        "rank",
        "is_active",
        "is_internal",
        "created_at",
        "updated_at",
        "metadata",
      ],
      filters,
    });

    if (!categories || categories.length === 0) {
      return res.json({
        product_categories: [],
        count: 0,
        offset: 0,
        limit: 50,
      });
    }

    const publishedCounts = await getPublishedProductCountsBySubtree(
      req.scope
    );

    // Add breadcrumbs and category_children to each category
    const categoriesWithBreadcrumbs = await Promise.all(
      categories.map(async (category) => {
        // Build breadcrumbs
        const breadcrumbs = await buildBreadcrumbs(category.id, query);

        // Get category_children (subcategories) with metadata
        const childrenFilters: any = { parent_category_id: category.id, is_active: true, is_internal: false };

        const { data: children } = await query.graph({
          entity: "product_category",
          fields: ["id", "name", "handle", "rank", "metadata"],
          filters: childrenFilters,
        });

        const childrenWithCounts = (children || []).map((child: any) => ({
          ...child,
          published_product_count: publishedCounts.get(child.id) || 0,
        }));

        return {
          ...category,
          published_product_count: publishedCounts.get(category.id) || 0,
          breadcrumbs,
          category_children: includeEmpty
            ? childrenWithCounts
            : childrenWithCounts.filter(
                (child) => child.published_product_count > 0
              ),
        };
      })
    );

    // Return in Medusa format
    return res.json({
      product_categories: categoriesWithBreadcrumbs,
      count: categoriesWithBreadcrumbs.length,
      offset: Number(req.query.offset) || 0,
      limit: Number(req.query.limit) || 50,
    });
  } catch (error: any) {
    return res.status(500).json({
      type: "internal_error",
      message: (error as Error).message || "Failed to retrieve categories",
    });
  }
};

async function buildBreadcrumbs(categoryId: string, query: any) {
  const breadcrumbs: Array<{ id: string; name: string; handle: string }> = [];
  let currentId: string | null | undefined = categoryId;
  let depth = 0;
  const MAX_DEPTH = 10;

  while (currentId && depth < MAX_DEPTH) {
    const { data: categories }: { data: any[] } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "handle", "parent_category_id"],
      filters: { id: currentId },
    });

    const cat: any = categories?.[0];
    if (!cat) break;

    breadcrumbs.unshift({
      id: cat.id,
      name: cat.name,
      handle: cat.handle,
    });

    currentId = cat.parent_category_id;
    depth++;
  }

  return breadcrumbs;
}

// Public endpoint
export const AUTHENTICATE = false;
