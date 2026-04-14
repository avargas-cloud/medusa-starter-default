import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../modules/product-attributes";

/**
 * Sync all attribute options to AttributeValue entities
 * Call this once to fix existing attributes
 * GET /admin/attributes/sync-values
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE);

  try {
    // Get all attribute keys with their values
    const allKeys = await productAttributesService.listAttributeKeys(
      {},
      {
        relations: ["values"],
      }
    );

    let synced = 0;
    let skipped = 0;

    for (const key of allKeys) {
      const options = key.options || [];
      const existingValues = key.values || [];

      if (options.length === 0) {
        skipped++;
        continue;
      }

      // Create map of existing values
      const existingValuesMap = new Map(
        existingValues.map((v: any) => [v.value, v])
      );

      // Find values to create
      const valuesToCreate = options
        .filter((option) => !existingValuesMap.has(option))
        .map((option) => ({
          value: option,
          attribute_key_id: key.id,
        }));

      // Find values to delete (exist as entities but not in options)
      const valuesToDelete = existingValues
        .filter((v: any) => !options.includes(v.value))
        .map((v: any) => v.id);

      if (valuesToCreate.length > 0) {
        await productAttributesService.createAttributeValues(valuesToCreate);
        synced++;
      }

      if (valuesToDelete.length > 0) {
        await productAttributesService.deleteAttributeValues(valuesToDelete);
      }
    }

    res.json({
      success: true,
      message: `Synced ${synced} attributes, skipped ${skipped}`,
      total: allKeys.length,
    });
  } catch (error) {
    console.error("Sync failed:", error);
    res.status(500).json({
      message: "Failed to sync attribute values",
      error: (error as Error).message,
    });
  }
}
