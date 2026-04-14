import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../../modules/product-attributes";

/**
 * Temporary verification endpoint to confirm cascade deletion worked
 * GET /admin/attributes/verify-deletion/:id
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params;
  const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE);
  const query = req.scope.resolve("query");

  try {
    const results: any = {
      attribute_id: id,
      checks: {},
    };

    // 1. Check if AttributeKey still exists
    try {
      const [attribute] = await productAttributesService.listAttributeKeys({
        id,
      });
      results.checks.attribute_key_exists = !!attribute;
      results.checks.attribute_key_data = attribute || null;
    } catch (error) {
      results.checks.attribute_key_exists = false;
      results.checks.attribute_key_error = (error as Error).message;
    }

    // 2. Check if AttributeValues still exist
    try {
      const values = await productAttributesService.listAttributeValues({
        attribute_key_id: id,
      });
      results.checks.attribute_values_count = values ? values.length : 0;
      results.checks.attribute_values_data = values || [];
    } catch (error) {
      results.checks.attribute_values_count = 0;
      results.checks.attribute_values_error = (error as Error).message;
    }

    // 3. Check if product links still exist in pivot table
    // First get any values that might exist (even if deleted)
    try {
      const { data: allValues } = await query.graph({
        entity: "attribute_value",
        fields: ["id"],
        filters: { attribute_key_id: id },
      });

      if (allValues && allValues.length > 0) {
        const valueIds = allValues.map((v: any) => v.id);
        const { data: links } = await query.graph({
          entity: "product_attribute_value",
          fields: ["product_id", "attribute_value_id"],
          filters: { attribute_value_id: valueIds },
        });
        results.checks.product_links_count = links ? links.length : 0;
        results.checks.product_links_data = links || [];
      } else {
        results.checks.product_links_count = 0;
        results.checks.product_links_data = [];
      }
    } catch (error) {
      results.checks.product_links_count = 0;
      results.checks.product_links_error = (error as Error).message;
    }

    // 4. Check category filter_config references
    const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
    const categoriesResponse = await fetch(
      `${basePath}/admin/product-categories?limit=1000`,
      {
        headers: {
          Cookie: req.headers.cookie || "",
          Authorization: req.headers.authorization || "",
        },
      }
    );

    if (categoriesResponse.ok) {
      const { product_categories } = await categoriesResponse.json();
      const categoriesWithRef = product_categories.filter((cat: any) => {
        const filters = cat.metadata?.filter_config?.active_filters;
        if (!filters) return false;

        if (Array.isArray(filters)) {
          if (typeof filters[0] === "string") {
            return filters.includes(id);
          } else {
            return filters.some((f: any) => f.attribute_id === id);
          }
        }
        return false;
      });

      results.checks.categories_with_reference = categoriesWithRef.map(
        (cat: any) => ({
          id: cat.id,
          name: cat.name,
          filter_config: cat.metadata?.filter_config,
        })
      );
      results.checks.categories_with_reference_count = categoriesWithRef.length;
    } else {
      results.checks.categories_error = "Failed to fetch categories";
    }

    // Summary
    results.summary = {
      fully_deleted:
        !results.checks.attribute_key_exists &&
        results.checks.attribute_values_count === 0 &&
        results.checks.product_links_count === 0 &&
        results.checks.categories_with_reference_count === 0,
    };

    res.json(results);
  } catch (error) {
    console.error("Error verifying deletion:", error);
    res.status(500).json({
      message: "Error verifying deletion",
      error: (error as Error).message,
    });
  }
}
