/**
 * Pure payload builder for the mass QB metadata sync.
 *
 * Converts classifier diffs into metadata patches that preserve every
 * unrelated key in product.metadata and variant.metadata. Idempotent under
 * repeated sibling merges: multiple calls for the same productId converge
 * on the same final product.metadata.
 */
import type {
  ProductFieldDiff,
  VariantFieldDiff,
} from "./classify-metadata-diff";
import type {
  MedusaProductView,
  MedusaVariantView,
} from "../../../lib/quickbooks/bulk-item-types";

export type ProductMetadataPatch = {
  productId: string;
  metadata: Record<string, unknown>;
};

export type VariantMetadataPatch = {
  variantId: string;
  productId: string;
  metadata: Record<string, unknown>;
};

export type PayloadMap = {
  products: Map<string, ProductMetadataPatch>;
  variants: Map<string, VariantMetadataPatch>;
};

function applyDiffsToMeta(
  current: Record<string, unknown> | null,
  diffs: Array<{ key: string; newValue: unknown; clearing?: boolean }>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const d of diffs) {
    if (d.clearing) {
      delete next[d.key];
    } else if (d.newValue === null || d.newValue === undefined) {
      // newValue=null with clearing=false means "set to null" — we store
      // explicit nulls so Medusa metadata reflects QB's empty state.
      next[d.key] = null;
    } else {
      next[d.key] = d.newValue;
    }
  }
  return next;
}

export function mergeProductDiff(
  map: PayloadMap,
  product: MedusaProductView,
  diffs: ProductFieldDiff[],
): void {
  if (diffs.length === 0) return;
  const existing = map.products.get(product.id);
  const base = existing?.metadata ?? product.metadata ?? null;
  const metadata = applyDiffsToMeta(base, diffs);
  map.products.set(product.id, { productId: product.id, metadata });
}

export function mergeVariantDiff(
  map: PayloadMap,
  variant: MedusaVariantView,
  diffs: VariantFieldDiff[],
): void {
  if (diffs.length === 0) return;
  const existing = map.variants.get(variant.id);
  const base = existing?.metadata ?? variant.metadata ?? null;
  const metadata = applyDiffsToMeta(base, diffs);
  map.variants.set(variant.id, {
    variantId: variant.id,
    productId: variant.productId,
    metadata,
  });
}

export function emptyPayloadMap(): PayloadMap {
  return { products: new Map(), variants: new Map() };
}
