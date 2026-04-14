import { IProductModuleService } from "@medusajs/framework/types";

export interface BreadcrumbItem {
  id: string;
  name: string;
  handle: string;
}

/**
 * Generates breadcrumb trail for a category by traversing up the parent hierarchy
 * @param categoryId - Starting category ID
 * @param productModuleService - Medusa Product Module Service
 * @returns Array of breadcrumb items from root to leaf
 */
export async function getCategoryBreadcrumbs(
  categoryId: string,
  productModuleService: IProductModuleService
): Promise<BreadcrumbItem[]> {
  const breadcrumbs: BreadcrumbItem[] = [];
  let currentCategoryId: string | null = categoryId;

  // Traverse up the category tree
  while (currentCategoryId) {
    const category = await productModuleService.retrieveProductCategory(
      currentCategoryId,
      {
        select: ["id", "name", "handle", "parent_category_id"],
      }
    );

    // Add to beginning of array (we're going bottom-up, want top-down result)
    breadcrumbs.unshift({
      id: category.id,
      name: category.name,
      handle: category.handle,
    });

    // Move to parent
    currentCategoryId = category.parent_category_id || null;
  }

  return breadcrumbs;
}

/**
 * Gets main category breadcrumbs for a product
 * Uses product.metadata.primary_category_id if set, otherwise falls back to first category
 * @param product - Product object
 * @param productModuleService - Medusa Product Module Service
 * @returns Breadcrumb trail or null if no categories
 */
export async function getProductMainCategoryBreadcrumbs(
  product: any,
  productModuleService: IProductModuleService
): Promise<BreadcrumbItem[] | null> {
  // Try to get primary category from metadata (existing widget uses this field)
  const primaryCategoryId = product.metadata?.primary_category_id as
    | string
    | undefined;

  if (primaryCategoryId) {
    return getCategoryBreadcrumbs(primaryCategoryId, productModuleService);
  }

  // Fallback: use first category if available
  if (product.categories && product.categories.length > 0) {
    return getCategoryBreadcrumbs(
      product.categories[0].id,
      productModuleService
    );
  }

  // No categories assigned
  return null;
}
