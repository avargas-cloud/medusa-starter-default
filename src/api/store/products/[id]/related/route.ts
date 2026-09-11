import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { withPublicProductMetadata } from "../../../../../lib/product-metadata/public-keys";
import {
  DEFAULT_RELATED_LIMIT,
  type RelatedSourceProduct,
  resolveRelatedProducts,
} from "../../../../../lib/related-products/resolve-related";
import { resolveStorePricingContext } from "../../../../../lib/store-pricing/pricing-context";

/**
 * GET /store/products/:id/related?limit=4
 *
 * Curated related products (product.metadata.related_products, ordered by the
 * operator) with the storefront rules applied on the fly: drafts dropped,
 * out-of-stock (Miami) sunk to the end, same-category fill, first `limit`.
 * Priced for the caller like every other /store/products* route.
 *
 * Consumed by the Astro build, the SSR fallback (through the consolidated
 * by-handle route) and the client-side refresh on the product page.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params;
  const rawLimit = Number((req.query as { limit?: string }).limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? rawLimit
      : DEFAULT_RELATED_LIMIT;

  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "product",
      fields: ["id", "status", "metadata", "categories.id"],
      filters: { id },
    });
    const product = data?.[0];
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const { context } = await resolveStorePricingContext(req, "STORE-RELATED");
    const related = await resolveRelatedProducts({
      container: req.scope,
      product: product as unknown as RelatedSourceProduct,
      pricingContext: context,
      limit,
    });

    return res.json({
      product_id: product.id,
      // El lib ya filtra; se repite ACÁ porque el verificador de exposición
      // afirma el filtro en la línea que arma la respuesta, no río abajo.
      related_products: related.map(withPublicProductMetadata),
      ids: related.map((p) => p.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[STORE-RELATED] Error:", message);
    return res.status(500).json({ error: "Failed to fetch related products" });
  }
};
