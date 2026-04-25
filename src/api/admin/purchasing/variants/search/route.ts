/**
 * GET /admin/purchasing/variants/search?q=...&exclude=id1,id2
 *
 * Quick variant search for the "Add Alternative" modal.
 * Uses MeiliSearch `inventory` index for fast fuzzy matching on SKU / title.
 * Returns up to 20 results, excluding variant IDs in the `exclude` param.
 *
 * Alternatives are at the variant (SKU) level, not the product level.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const q       = ((req.query as Record<string, string>).q ?? "").trim();
  const exclude = ((req.query as Record<string, string>).exclude ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (q.length < 2) {
    return res.json({ variants: [] });
  }

  try {
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const filter = exclude.length > 0
      ? exclude.map((id) => `variantId != "${id}"`).join(" AND ")
      : undefined;

    const results = await client.index("inventory").search<{
      variantId: string;
      sku: string;
      title: string;
      totalStock: number | null;
    }>(q, {
      limit: 20,
      attributesToRetrieve: ["variantId", "sku", "title", "totalStock"],
      ...(filter ? { filter } : {}),
    });

    const variants = results.hits.map((h) => ({
      id:            h.variantId,
      sku:           h.sku,
      product_title: h.title,
      inv_usa:       h.totalStock ?? 0,
    }));

    return res.json({ variants });
  } catch (e) {
    return res.status(500).json({
      error: "Search failed",
      message: (e as Error).message,
      variants: [],
    });
  }
}
