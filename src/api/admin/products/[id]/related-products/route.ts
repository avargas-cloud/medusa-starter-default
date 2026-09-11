import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { IProductModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import {
  MAX_RELATED,
  planReciprocalWrites,
  sanitizeRelatedIds,
} from "../../../../../lib/related-products/reciprocal";
import {
  fetchInStockByProduct,
  readCuratedIds,
} from "../../../../../lib/related-products/resolve-related";

/**
 * GET/PUT /admin/products/:id/related-products
 *
 * The curated list behind the storefront "Related Products" section, stored
 * as product.metadata.related_products (ordered ids, max MAX_RELATED).
 *
 * PUT validates (ids exist, no self, no dupes, cap), READ-MODIFY-WRITES the
 * metadata key (Medusa merges metadata per key — an array replaces the old
 * array; we never delete the key, we write []), and applies the operator's
 * reciprocity rule: every NEWLY added target gets this product appended if it
 * has room. Removals never cascade. Catalogue curation, not money: no PIN.
 */

type ProductLite = {
  id: string;
  title: string;
  handle: string;
  thumbnail: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
};

const LITE_FIELDS = [
  "id",
  "title",
  "handle",
  "thumbnail",
  "status",
  "metadata",
];

const loadProducts = async (
  req: AuthenticatedMedusaRequest,
  ids: string[]
): Promise<ProductLite[]> => {
  if (ids.length === 0) return [];
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product",
    fields: LITE_FIELDS,
    filters: { id: ids },
  });
  return data as ProductLite[];
};

const hydrate = async (req: AuthenticatedMedusaRequest, ids: string[]) => {
  const rows = await loadProducts(req, ids);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const inStock = await fetchInStockByProduct(req.scope, ids);
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is ProductLite => Boolean(r))
    .map((r) => ({
      id: r.id,
      title: r.title,
      handle: r.handle,
      thumbnail: r.thumbnail,
      status: r.status,
      in_stock: inStock.get(r.id) ?? true,
    }));
};

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const id = String(req.params.id ?? "");
  const [self] = await loadProducts(req, [id]);
  if (!self) return res.status(404).json({ message: "Product not found" });

  const ids = readCuratedIds(self.metadata, id);
  return res.json({
    product_id: id,
    ids,
    items: await hydrate(req, ids),
    max: MAX_RELATED,
  });
};

export const PUT = async (
  req: AuthenticatedMedusaRequest<{ ids?: unknown }>,
  res: MedusaResponse
) => {
  const id = String(req.params.id ?? "");
  const body = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(body.ids)) {
    return res
      .status(400)
      .json({ message: "`ids` must be an array of product ids" });
  }
  if (body.ids.length > MAX_RELATED) {
    return res
      .status(400)
      .json({ message: `At most ${MAX_RELATED} related products` });
  }
  if (body.ids.some((v) => v === id)) {
    return res
      .status(400)
      .json({ message: "A product cannot be related to itself" });
  }
  if (body.ids.some((v) => typeof v !== "string" || !v.trim())) {
    return res
      .status(400)
      .json({ message: "`ids` must contain non-empty strings" });
  }
  // Duplicates are collapsed silently (first occurrence wins).
  const nextIds = sanitizeRelatedIds(id, body.ids);

  const [self] = await loadProducts(req, [id]);
  if (!self) return res.status(404).json({ message: "Product not found" });

  const targets = await loadProducts(req, nextIds);
  const missing = nextIds.filter((t) => !targets.some((r) => r.id === t));
  if (missing.length) {
    return res
      .status(400)
      .json({ message: `Unknown product ids: ${missing.join(", ")}` });
  }

  const previousIds = readCuratedIds(self.metadata, id);
  const targetLists = Object.fromEntries(
    targets.map((t) => [t.id, readCuratedIds(t.metadata, t.id)] as const)
  );
  const reciprocal = planReciprocalWrites({
    selfId: id,
    previousIds,
    nextIds,
    targetLists,
  });

  const productModule = req.scope.resolve(
    Modules.PRODUCT
  ) as IProductModuleService;
  // Read-modify-write: spread the CURRENT metadata so no sibling key is lost.
  await productModule.updateProducts(id, {
    metadata: { ...(self.metadata ?? {}), related_products: nextIds },
  });
  for (const u of reciprocal.updates) {
    const target = targets.find((t) => t.id === u.id);
    await productModule.updateProducts(u.id, {
      metadata: { ...(target?.metadata ?? {}), related_products: u.ids },
    });
  }

  console.log(
    `[RELATED-PRODUCTS] ${req.auth_context?.actor_id ?? "?"} set ${id} → [${nextIds.join(",")}]` +
      (reciprocal.updates.length
        ? ` reciprocal +${reciprocal.updates.map((u) => u.id).join(",")}`
        : "") +
      (reciprocal.skippedFull.length
        ? ` skipped(full) ${reciprocal.skippedFull.join(",")}`
        : "")
  );

  return res.json({
    product_id: id,
    ids: nextIds,
    items: await hydrate(req, nextIds),
    reciprocal: {
      added_to: reciprocal.updates.map((u) => u.id),
      skipped_full: reciprocal.skippedFull,
    },
    max: MAX_RELATED,
  });
};
