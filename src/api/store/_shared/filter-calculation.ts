import { Knex } from "knex";

/**
 * Calculates dynamic filters based on actual product IDs
 * Shared function used by /store/categories/:id/filters and /store/categories/:id/products-with-filters
 */
export async function calculateFilters(
  productIds: string[],
  knex: Knex,
  queryService: any,
  configuredFilters: any[]
): Promise<any[]> {
  if (productIds.length === 0) {
    // Return filters with 0 counts
    return configuredFilters.map((filter) => ({
      ...filter,
      options: (filter.options || []).map(
        (opt: string | { option: string }) => ({
          option: typeof opt === "string" ? opt : opt.option,
          count: 0,
        })
      ),
    }));
  }

  // Fetch ALL attribute links for ALL products in one query
  const allLinks = await knex(
    "product_product_productattributes_attribute_value"
  )
    .select("product_id", "attribute_value_id")
    .whereIn("product_id", productIds)
    .whereNull("deleted_at");

  if (allLinks.length === 0) {
    // Return filters with 0 counts
    return configuredFilters.map((filter) => ({
      ...filter,
      options: (filter.options || []).map(
        (opt: string | { option: string }) => ({
          option: typeof opt === "string" ? opt : opt.option,
          count: 0,
        })
      ),
    }));
  }

  // Get unique attribute value IDs
  const allAttributeValueIds = [
    ...new Set(allLinks.map((l: any) => l.attribute_value_id)),
  ];

  // Fetch all attribute values with their keys
  const { data: allAttributeValues } = await queryService.graph({
    entity: "attribute_value",
    fields: [
      "id",
      "value",
      "attribute_key.id",
      "attribute_key.handle",
      "attribute_key.label",
    ],
    filters: { id: allAttributeValueIds },
  });

  // Count products per filter value
  const filters = configuredFilters.map((filter) => {
    const optionCounts: Record<string, number> = {};

    // Extract original string options (if predefined)
    const originalOptions: string[] =
      Array.isArray(filter.options) && filter.options.length > 0
        ? typeof filter.options[0] === "string"
          ? (filter.options as string[])
          : (filter.options as Array<{ option: string }>).map(
              (v: any) => v.option
            )
        : [];

    // Count products for each option (and discover new options if not predefined)
    allLinks.forEach((link: any) => {
      const attrValue = allAttributeValues.find(
        (av: any) => av.id === link.attribute_value_id
      );
      if (!attrValue) return;

      // Match by attribute handle
      if (attrValue.attribute_key?.handle === filter.attribute) {
        const value = attrValue.value;

        // If no predefined options, discover all unique values
        if (originalOptions.length === 0) {
          optionCounts[value] = (optionCounts[value] || 0) + 1;
        } else {
          // Only count if in predefined options
          if (originalOptions.includes(value)) {
            optionCounts[value] = (optionCounts[value] || 0) + 1;
          }
        }
      }
    });

    // Determine final options list
    const finalOptions =
      originalOptions.length > 0
        ? originalOptions // Use predefined options
        : Object.keys(optionCounts).sort(); // Discover from products (sorted)

    // Format as array
    const options = finalOptions.map((option) => ({
      option,
      count: optionCounts[option] || 0,
    }));

    return {
      ...filter,
      options,
    };
  });

  return filters;
}
