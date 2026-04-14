import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /api/debug/category-metadata/:name
 *
 * Public endpoint (no auth) to inspect category metadata
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { name } = req.params;

  if (!name) {
    return res.status(400).json({ error: "name required" });
  }
  const query = req.scope.resolve("query");

  try {
    const { data: categories } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "metadata"],
      filters: { name: name.toUpperCase() },
    });

    if (!categories || categories.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    return res.json(categories[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
