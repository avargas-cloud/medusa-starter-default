/**
 * Pure transform: Medusa variant graph → MeiliSearch `inventory` documents.
 *
 * Extracted from `src/workflows/sync-inventory.ts` so the same shape is used
 * by the full nuke-rebuild workflow AND the incremental single-item sync
 * used by subscribers. Keep both in lockstep — any schema change here must
 * be reflected in both call sites.
 *
 * The input is expected to come from a `query.graph({ entity: 'product_variant', ... })`
 * with at least the fields referenced below. Fields are optional-safe: if a
 * relation is missing the document still renders with sensible defaults.
 */

export interface MeiliInventoryDoc {
  id: string;
  sku: string;
  sku_plain: string;
  title: string;
  thumbnail: string | null;
  totalStock: number | null;
  totalReserved: number;
  price: number;
  currencyCode: string;
  pricesByList: Record<string, number>;
  variantId: string;
  productId: string | null;
  handle: string | null;
  salesDescription: string | null;
  purchaseDescription: string | null;
  quickbooks_id: string | null;
  purchaseCost: number | null;   // qb_purchase_cost — fixed purchase price on the QB item
  cost: number | null;          // qb_avg_cost — QB running average cost
  avg_landed_cost: number | null; // avg_landed_cost_cents — our AVCO, used for profit calcs
  vendorName: string | null;
  mpn: string | null;
  chinaStock: number;
  // Open inbound balance (qty_ordered − received − cancelled) on documents in
  // status submitted/partially_received. USA = Purchase Orders, China = Factory
  // Orders. Independent of chinaStock (current availability) — never net them.
  onOrderUsa: number;
  onOrderChina: number;
  options: { title: string; value: string }[];
  category_handles: string[];
  status: string;
  created_at: number;
  updated_at: number;
}

type AnyRec = Record<string, unknown>;

export function buildInventoryDocsForVariants(
  variants: any[],
  pricesByPriceSet: Map<string, Record<string, number>> = new Map(),
  chinaStockMap: Map<string, number> = new Map(),
  // Miami-only stock/reserved keyed by inventory_item_id. When omitted, falls
  // back to the aggregate `inventory.stocked_quantity` (legacy behavior).
  // China is intentionally excluded — orders ship from Miami; China is shown
  // separately via `chinaStock`.
  miamiStockMap: Map<string, number> = new Map(),
  miamiReservedMap: Map<string, number> = new Map(),
  // variant.id → vendor display name, from the canonical qb_vendor ↔ variant
  // remote link (see loadVendorNamesByVariantId). The legacy
  // variant.metadata.qb_vendor_name is being phased out, so the link is the
  // source of truth; we only fall back to the legacy field when unmapped.
  vendorNameByVariantId: Map<string, string> = new Map(),
  // Open on-order balances keyed by inventory_item_id. USA = open Purchase
  // Orders, China = open Factory Orders. Default 0 when absent.
  onOrderUsaMap: Map<string, number> = new Map(),
  onOrderChinaMap: Map<string, number> = new Map()
): MeiliInventoryDoc[] {
  const docs: MeiliInventoryDoc[] = [];

  for (const variant of variants) {
    const product = variant.product;
    const usdPrices = (variant.prices || []).filter(
      (p: any) => p.currency_code === "usd"
    );
    const retailPrice =
      usdPrices.length > 0
        ? usdPrices.reduce((max: any, p: any) =>
            p.amount > max.amount ? p : max
          )
        : null;

    const priceSetId = variant.price_set?.id;
    const pricesByList = priceSetId
      ? (pricesByPriceSet.get(priceSetId) ?? {})
      : {};

    const allCategoryHandles = new Set<string>();
    product?.categories?.forEach((c: any) => {
      if (c?.handle) allCategoryHandles.add(c.handle);
      if (c?.parent_category?.handle)
        allCategoryHandles.add(c.parent_category.handle);
      if (c?.parent_category?.parent_category?.handle)
        allCategoryHandles.add(c.parent_category.parent_category.handle);
    });

    const mappedOptions = (variant.options || []).map((opt: any) => ({
      title: opt?.option?.title || "Option",
      value: opt?.value || "",
    }));

    const vmeta = (variant?.metadata || {}) as AnyRec;

    // Prefer the canonical vendor link; fall back to the legacy metadata field.
    const vendorName =
      vendorNameByVariantId.get(variant.id) ||
      (vmeta.qb_vendor_name as string) ||
      null;

    // variant.thumbnail is set explicitly per-variant when a specific finish
    // image is needed. Falls back to the product-level thumbnail.
    // Intentionally skips variant.images[0] — that array can contain secondary
    // images that are NOT the representative thumbnail for the variant.
    const resolvedThumbnail = variant.thumbnail ?? product?.thumbnail ?? null;

    // No inventory items → synthetic doc keyed by variant.id (services etc.)
    if (!variant.inventory_items || variant.inventory_items.length === 0) {
      if (!variant.sku) continue;
      docs.push({
        id: variant.id,
        sku: variant.sku,
        sku_plain: (variant.sku as string).replace(/-/g, ""),
        title: product?.title || "Untitled",
        thumbnail: resolvedThumbnail,
        totalStock: null,
        totalReserved: 0,
        price: retailPrice?.amount || 0,
        currencyCode:
          (retailPrice?.currency_code as string | undefined)?.toUpperCase() ||
          "USD",
        pricesByList,
        variantId: variant.id,
        productId: product?.id || null,
        handle: product?.handle || null,
        salesDescription: (vmeta.sales_description as string) || null,
        purchaseDescription: (vmeta.purchase_description as string) || null,
        quickbooks_id: (vmeta.quickbooks_id as string) || null,
        purchaseCost: (vmeta.qb_purchase_cost as number) || null,
        cost: (vmeta.qb_avg_cost as number) || null,
        avg_landed_cost: (vmeta.avg_landed_cost_cents as number) || null,
        vendorName,
        mpn: (vmeta.mpn as string) || null,
        chinaStock: 0,
        onOrderUsa: 0,
        onOrderChina: 0,
        options: mappedOptions,
        category_handles: Array.from(allCategoryHandles),
        status: product?.status || "draft",
        created_at: new Date(variant.created_at).getTime(),
        updated_at: new Date(variant.updated_at).getTime(),
      });
      continue;
    }

    for (const invItem of variant.inventory_items) {
      const inventory = invItem?.inventory;
      if (!inventory?.id) continue;
      // Use 0 as fallback when the Miami inventory_level row is absent —
      // falling back to inventory.stocked_quantity (aggregate across ALL
      // locations) would silently include China stock in totalStock.
      const miamiStock = miamiStockMap.get(inventory.id) ?? 0;
      const miamiReserved = miamiReservedMap.get(inventory.id) ?? 0;
      docs.push({
        id: inventory.id,
        sku: inventory.sku || variant.sku || "",
        sku_plain: (inventory.sku || variant.sku || "").replace(/-/g, ""),
        title: inventory.title || product?.title || "Untitled",
        thumbnail: resolvedThumbnail,
        totalStock: miamiStock,
        totalReserved: miamiReserved,
        price: retailPrice?.amount || 0,
        currencyCode:
          (retailPrice?.currency_code as string | undefined)?.toUpperCase() ||
          "USD",
        pricesByList,
        variantId: variant.id,
        productId: product?.id || null,
        handle: product?.handle || null,
        salesDescription: (vmeta.sales_description as string) || null,
        purchaseDescription: (vmeta.purchase_description as string) || null,
        quickbooks_id: (vmeta.quickbooks_id as string) || null,
        purchaseCost: (vmeta.qb_purchase_cost as number) || null,
        cost: (vmeta.qb_avg_cost as number) || null,
        avg_landed_cost: (vmeta.avg_landed_cost_cents as number) || null,
        vendorName,
        mpn: (vmeta.mpn as string) || null,
        chinaStock: chinaStockMap.get(inventory.id) ?? 0,
        onOrderUsa: onOrderUsaMap.get(inventory.id) ?? 0,
        onOrderChina: onOrderChinaMap.get(inventory.id) ?? 0,
        options: mappedOptions,
        category_handles: Array.from(allCategoryHandles),
        status: product?.status || "draft",
        created_at: new Date(
          inventory.created_at || variant.created_at
        ).getTime(),
        updated_at: new Date(
          inventory.updated_at || variant.updated_at
        ).getTime(),
      });
    }
  }

  return docs;
}

export const INVENTORY_DOC_FIELDS = [
  "id",
  "sku",
  "thumbnail",
  "metadata",
  "created_at",
  "updated_at",
  "price_set.id",
  "product.id",
  "product.title",
  "product.handle",
  "product.thumbnail",
  "product.status",
  "product.metadata",
  "product.categories.id",
  "product.categories.handle",
  "product.categories.parent_category.handle",
  "product.categories.parent_category.parent_category.handle",
  "prices.amount",
  "prices.currency_code",
  "prices.price_list_id",
  "inventory_items.inventory.id",
  "inventory_items.inventory.sku",
  "inventory_items.inventory.title",
  "inventory_items.inventory.created_at",
  "inventory_items.inventory.updated_at",
  "inventory_items.inventory.stocked_quantity",
  "inventory_items.inventory.reserved_quantity",
  "options.value",
  "options.option.title",
  "metadata",
] as const;
