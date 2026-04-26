/**
 * GET /admin/purchasing/variants/search?q=...&exclude=id1,id2
 *
 * Quick variant search for the "Add Alternative" modal.
 * Uses MeiliSearch `inventory` index for fast fuzzy matching on SKU / title.
 * Returns up to 20 results, excluding variant IDs in the `exclude` param.
 *
 * Each result includes `is_primary` and `own_alt_count` so the UI can detect
 * when the selected variant is itself a primary and offer the merge flow.
 *
 * Alternatives are at the variant (SKU) level, not the product level.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { withDb } from "../../_lib/db";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const q = ((req.query as Record<string, string>).q ?? "").trim();
  const exclude = ((req.query as Record<string, string>).exclude ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (q.length < 2) {
    return res.json({ variants: [] });
  }

  return withDb(async (db) => {
    try {
      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });

      const filter =
        exclude.length > 0
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

      const variantIds = results.hits
        .map((h) => h.variantId)
        .filter(Boolean);

      // Check which results are already primaries with at least one active alt
      let primaryMap: Record<string, number> = {};
      if (variantIds.length > 0) {
        const pc = await db.query<{ primary_variant_id: string; n: string }>(
          `SELECT primary_variant_id, COUNT(*) AS n
           FROM product_alternative
           WHERE primary_variant_id = ANY($1::text[])
             AND is_active = true
             AND deleted_at IS NULL
           GROUP BY primary_variant_id`,
          [variantIds]
        );
        primaryMap = Object.fromEntries(
          pc.rows.map((r) => [r.primary_variant_id, parseInt(r.n, 10)])
        );
      }

      const variants = results.hits.map((h) => ({
        id: h.variantId,
        sku: h.sku,
        product_title: h.title,
        inv_usa: h.totalStock ?? 0,
        is_primary: primaryMap[h.variantId] !== undefined,
        own_alt_count: primaryMap[h.variantId] ?? 0,
      }));

      return res.json({ variants });
    } catch (e) {
      return res.status(500).json({
        error: "Search failed",
        message: (e as Error).message,
        variants: [],
      });
    }
  });
}
