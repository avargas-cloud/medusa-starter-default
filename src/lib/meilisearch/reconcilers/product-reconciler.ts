import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { EntityReconciler } from "../drift-reconciler";
import { syncProductToMeiliSearchWorkflow } from "../../../workflows/sync-product-meilisearch";

/**
 * Builds the expected `products` Meili doc the same way
 * src/workflows/sync-product-meilisearch.ts:syncProductDocStep does — so we
 * can compare it against the live Meili document.
 *
 * Keep this shape in sync with the workflow's `document` literal. If a new
 * field becomes searchable/filterable in the products index, add it both
 * places and add it to `comparableFields` below.
 */
async function buildExpectedProductDoc(
  productId: string,
  container: MedusaContainer
): Promise<Record<string, unknown> | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "description",
      "handle",
      "thumbnail",
      "status",
      "metadata",
      "variants.sku",
    ],
    filters: { id: productId },
  });
  const product = products?.[0];
  if (!product) return null;

  const variants = (product.variants as { sku?: string | null }[] | undefined) ?? [];
  const variantSkus = variants
    .map((v) => v.sku)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const meta = (product.metadata as Record<string, unknown> | null) ?? {};

  return {
    id: product.id,
    title: product.title ?? "",
    description: product.description ?? "",
    handle: product.handle ?? "",
    thumbnail: product.thumbnail ?? null,
    status: product.status ?? "",
    variant_sku: variantSkus,
    metadata_material: (meta.material as string | null | undefined) ?? null,
    metadata_category: (meta.category as string | null | undefined) ?? null,
  };
}

export const productReconciler: EntityReconciler = {
  entityType: "product",
  meiliIndex: "products",
  comparableFields: [
    "title",
    "description",
    "handle",
    "thumbnail",
    "status",
    "variant_sku",
    "metadata_material",
    "metadata_category",
  ],
  buildExpectedDoc: buildExpectedProductDoc,
  syncOne: async (id, container) => {
    // Delegate to the canonical workflow — keeps sync logic single-sourced.
    // The workflow also cascades to the inventory index, which we want.
    await syncProductToMeiliSearchWorkflow(container).run({
      input: { productId: id },
    });
  },
  fetchUpdatedIdsSince: async (sql, sinceIso, limit) => {
    // Union of products updated directly OR products whose variants were
    // updated — both can drift the products index (variant SKU list).
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM (
        SELECT id, updated_at FROM product
          WHERE deleted_at IS NULL AND updated_at >= ${sinceIso}
        UNION
        SELECT product_id AS id, updated_at FROM product_variant
          WHERE deleted_at IS NULL AND updated_at >= ${sinceIso}
            AND product_id IS NOT NULL
      ) p
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },
};
