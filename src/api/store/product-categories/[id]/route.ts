import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getPublishedProductCountsBySubtree } from "../../../../lib/catalog/category-published-counts";

/**
 * GET /store/product-categories/:id
 *
 * Custom endpoint that overrides the native one to add breadcrumbs automatically.
 * Returns the category with breadcrumbs field included.
 *
 * Storefront-safety defaults (unless overridden by the caller):
 * - is_active: true, is_internal: false — pass ?include_inactive=true to skip
 *   the filter (the requested category itself is still 404'd if it is
 *   inactive/internal and include_inactive is not set).
 * - category_children with zero published products in their subtree are
 *   dropped — pass ?include_empty=true to keep them.
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const categoryId = req.params.id;
  const query = req.scope.resolve("query");
  const includeInactive = req.query.include_inactive === "true";
  const includeEmpty = req.query.include_empty === "true";

  try {
    // Get full category data using query.graph with explicit fields
    const categoryFilters: any = { id: categoryId };
    if (!includeInactive) {
      categoryFilters.is_active = true;
      categoryFilters.is_internal = false;
    }

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
      filters: categoryFilters,
    });

    const category = categories?.[0];

    if (!category) {
      return res.status(404).json({
        type: "not_found",
        message: `Product category with id: ${categoryId} was not found`,
      });
    }

    // Build breadcrumbs
    const breadcrumbs: Array<{ id: string; name: string; handle: string }> = [];
    let currentId: string | null | undefined = categoryId;
    let depth = 0;
    const MAX_DEPTH = 10;

    while (currentId && depth < MAX_DEPTH) {
      const { data: cats }: { data: any[] } = await query.graph({
        entity: "product_category",
        fields: ["id", "name", "handle", "parent_category_id"],
        filters: { id: currentId },
      });

      const cat: any = cats?.[0];
      if (!cat) break;

      breadcrumbs.unshift({
        id: cat.id,
        name: cat.name,
        handle: cat.handle,
      });

      currentId = cat.parent_category_id;
      depth++;
    }

    // Get category_children (subcategories) with metadata
    const { data: children } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "handle", "rank", "metadata"],
      filters: { parent_category_id: categoryId },
    });

    const publishedCounts = await getPublishedProductCountsBySubtree(
      req.scope
    );

    const childrenWithCounts = (children || []).map((child: any) => ({
      ...child,
      published_product_count: publishedCounts.get(child.id) || 0,
    }));

    // Add breadcrumbs and children to response
    const categoryWithBreadcrumbs = {
      ...category,
      published_product_count: publishedCounts.get(category.id) || 0,
      breadcrumbs,
      category_children: includeEmpty
        ? childrenWithCounts
        : childrenWithCounts.filter(
            (child) => child.published_product_count > 0
          ),
    };

    return res.json({
      product_category: categoryWithBreadcrumbs,
    });
  } catch (error: any) {
    return res.status(500).json({
      type: "internal_error",
      message: (error as Error).message || "Failed to retrieve category",
    });
  }
};

// Public endpoint
export const AUTHENTICATE = false;
