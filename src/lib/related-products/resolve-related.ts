import type {
  BigNumberInput,
  IPricingModuleService,
  MedusaContainer,
} from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { USA_LOC } from "../locations";
import {
  withPublicProductMetadata,
  withPublicVariantMetadata,
} from "../product-metadata/public-keys";
import type { StorePricingContext } from "../store-pricing/pricing-context";

import { planRelatedProducts, type RelatedCandidate } from "./plan-related";
import { sanitizeRelatedIds } from "./reciprocal";

/** Storefront shows 4 cards; the operator can curate up to MAX_RELATED. */
export const DEFAULT_RELATED_LIMIT = 4;
export const MAX_RELATED_LIMIT = 8;

const RELATED_FIELDS = [
  "id",
  "title",
  "handle",
  "status",
  "thumbnail",
  "metadata",
  "variants.*",
  "variants.price_set.id",
];

type ProductRow = {
  id: string;
  status?: string;
  variants?: { id: string; price_set?: { id?: string } | null }[];
  [k: string]: unknown;
};

type KnexLike = (table: string) => {
  join: (...a: unknown[]) => unknown;
  [k: string]: unknown;
};

/** Curated ids as persisted by the admin route — tolerant of legacy shapes. */
export const readCuratedIds = (metadata: unknown, selfId: string): string[] => {
  const raw = (metadata as { related_products?: unknown } | null)
    ?.related_products;
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((v) =>
    typeof v === "string" ? v : (v as { id?: unknown } | null)?.id
  );
  return sanitizeRelatedIds(selfId, ids);
};

/**
 * Storefront availability = Miami only (same policy as prices-and-stock and
 * Meili totalStock). A product with no inventory rows at all is treated as in
 * stock: there is no signal to sink it on.
 */
export const fetchInStockByProduct = async (
  container: MedusaContainer,
  productIds: string[]
): Promise<Map<string, boolean>> => {
  const result = new Map<string, boolean>();
  if (productIds.length === 0) return result;

  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;
  const rows = (await (knex("product_variant as pv") as any)
    .join("product_variant_inventory_item as pvi", "pvi.variant_id", "pv.id")
    .join(
      "inventory_level as il",
      "il.inventory_item_id",
      "pvi.inventory_item_id"
    )
    .select("pv.product_id")
    .sum({ stocked: "il.stocked_quantity" })
    .sum({ reserved: "il.reserved_quantity" })
    .whereIn("pv.product_id", productIds)
    .where("il.location_id", USA_LOC)
    .whereNull("pv.deleted_at")
    .whereNull("pvi.deleted_at")
    .whereNull("il.deleted_at")
    .groupBy("pv.product_id")) as {
    product_id: string;
    stocked: string | number | null;
    reserved: string | number | null;
  }[];

  for (const r of rows) {
    const available = Number(r.stocked ?? 0) - Number(r.reserved ?? 0);
    result.set(r.product_id, available > 0);
  }
  return result;
};

const priceProducts = async (
  container: MedusaContainer,
  products: ProductRow[],
  pricingContext: StorePricingContext
) => {
  const pricingModule = container.resolve("pricing") as IPricingModuleService;
  const priceSetIds = products
    .flatMap((p) => p.variants ?? [])
    .map((v) => v.price_set?.id)
    .filter((x): x is string => Boolean(x));
  const prices = priceSetIds.length
    ? await pricingModule.calculatePrices(
        { id: priceSetIds },
        { context: pricingContext as unknown as Record<string, BigNumberInput> }
      )
    : [];
  const byPriceSet = new Map(prices.map((p) => [p.id, p] as const));

  return products.map((p) => ({
    ...withPublicProductMetadata(p as any),
    variants: (p.variants ?? [])
      .map((v) => {
        const pr = byPriceSet.get(v.price_set?.id ?? "");
        return {
          ...v,
          calculated_price: pr
            ? {
                calculated_amount: pr.calculated_amount,
                original_amount: pr.original_amount,
                currency_code: pr.currency_code,
              }
            : null,
        };
      })
      .map(withPublicVariantMetadata as any),
  }));
};

export interface RelatedSourceProduct {
  id: string;
  metadata?: unknown;
  categories?: { id: string }[] | null;
}

export interface ResolveRelatedInput {
  container: MedusaContainer;
  product: RelatedSourceProduct;
  pricingContext: StorePricingContext;
  limit?: number;
}

/**
 * Curated → published → in-stock first → same-category fill → first `limit`,
 * priced for the caller. Single source of truth for every storefront path
 * (build, SSR and the in-flight client refresh).
 */
export const resolveRelatedProducts = async (input: ResolveRelatedInput) => {
  const { container, product, pricingContext } = input;
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_RELATED_LIMIT),
    MAX_RELATED_LIMIT
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const curatedIds = readCuratedIds(product.metadata, product.id);

  const curatedRows: ProductRow[] = curatedIds.length
    ? ((
        await query.graph({
          entity: "product",
          fields: RELATED_FIELDS,
          filters: { id: curatedIds },
        })
      ).data as ProductRow[])
    : [];

  const inStock = await fetchInStockByProduct(
    container,
    curatedRows.map((r) => r.id)
  );
  const candidates: RelatedCandidate[] = curatedRows.map((r) => ({
    id: r.id,
    published: r.status === "published",
    inStock: inStock.get(r.id) ?? true,
  }));

  // Fallback only when curation cannot fill the section on its own.
  const curatedSurvivors = candidates.filter((c) => c.published).length;
  let fallbackRows: ProductRow[] = [];
  const categoryId = product.categories?.[0]?.id;
  if (curatedSurvivors < limit && categoryId) {
    fallbackRows = (
      await query.graph({
        entity: "product",
        fields: RELATED_FIELDS,
        filters: {
          categories: { id: categoryId },
          status: "published",
          id: { $ne: product.id },
        } as any,
        pagination: { take: limit + curatedIds.length + 1, skip: 0 },
      })
    ).data as ProductRow[];
  }

  const orderedIds = planRelatedProducts({
    selfId: product.id,
    curatedIds,
    candidates,
    fallbackIds: fallbackRows.map((r) => r.id),
    limit,
  });

  const rowsById = new Map<string, ProductRow>();
  for (const r of [...curatedRows, ...fallbackRows]) rowsById.set(r.id, r);
  const ordered = orderedIds
    .map((id) => rowsById.get(id))
    .filter((r): r is ProductRow => Boolean(r));

  return priceProducts(container, ordered, pricingContext);
};
