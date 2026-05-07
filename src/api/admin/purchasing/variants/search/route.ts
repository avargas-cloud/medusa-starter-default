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
): Promise<unknown> {
  const q = ((req.query as Record<string, string>).q ?? "").trim();
  const query = req.query as Record<string, string>;
  const exclude = (query.exclude ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mainOnly = query.main_only === "true" || query.main_only === "1";

  if (q.length < 2) {
    return res.json({ variants: [] });
  }

  return withDb(async (db) => {
    try {
      const host = process.env.MEILISEARCH_HOST;
      const apiKey = process.env.MEILISEARCH_API_KEY;
      if (!host || !apiKey) {
        return res.status(500).json({
          error: "Search failed",
          message: "MeiliSearch is not configured",
          variants: [],
        });
      }
      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host,
        apiKey,
      });

      const filter =
        exclude.length > 0
          ? exclude.map((id) => `variantId != "${id}"`).join(" AND ")
          : undefined;

      const results = await client.index("inventory").search<{
        variantId: string;
        productId?: string;
        sku: string;
        title: string;
        totalStock: number | null;
      }>(q, {
        limit: 20,
        attributesToRetrieve: [
          "variantId",
          "productId",
          "sku",
          "title",
          "totalStock",
        ],
        ...(filter ? { filter } : {}),
      });

      const variantIds = results.hits.map((h) => h.variantId).filter(Boolean);

      let alternativeSet = new Set<string>();
      if (mainOnly && variantIds.length > 0) {
        const alternatives = await db.query<{ alt_variant_id: string }>(
          `SELECT alt_variant_id
           FROM product_alternative
           WHERE alt_variant_id = ANY($1::text[])
             AND is_active = true
             AND deleted_at IS NULL`,
          [variantIds]
        );
        alternativeSet = new Set(
          alternatives.rows.map((r) => r.alt_variant_id)
        );
      }

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

      const missingProductVariantIds = results.hits
        .filter((h) => !h.productId)
        .map((h) => h.variantId)
        .filter(Boolean);
      let productMap: Record<string, string> = {};
      if (missingProductVariantIds.length > 0) {
        const products = await db.query<{ id: string; product_id: string }>(
          `SELECT id, product_id
           FROM product_variant
           WHERE id = ANY($1::text[])
             AND deleted_at IS NULL`,
          [missingProductVariantIds]
        );
        productMap = Object.fromEntries(
          products.rows.map((r) => [r.id, r.product_id])
        );
      }

      const variants = results.hits
        .filter((h) => !mainOnly || !alternativeSet.has(h.variantId))
        .map((h) => ({
          id: h.variantId,
          product_id: h.productId ?? productMap[h.variantId] ?? null,
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
