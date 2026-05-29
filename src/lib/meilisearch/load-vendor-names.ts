import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * Map product_variant_id → vendor display name, read from the canonical
 * qb_vendor ↔ product_variant remote link.
 *
 * The Meili `inventory` index used to read vendorName from the legacy
 * variant.metadata.qb_vendor_name, but that field is being cleaned up across the
 * DB (see scripts/qb_sync/lib/cleanup-legacy-vendor-keys.ts), which left every
 * inventory doc with a null vendor. The link table is the source of truth.
 *
 * Pass `variantIds` to scope the lookup (incremental syncs); omit to load every
 * link (full rebuild). The link is isList, but a variant maps to one preferred
 * vendor for PO purposes, so the first match wins.
 */
export async function loadVendorNamesByVariantId(
  container: MedusaContainer,
  variantIds?: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (variantIds && variantIds.length === 0) return map;

  const knex = (container as { resolve: (k: string) => any }).resolve(
    "__pg_connection__"
  );

  const rows: Array<{
    variant_id: string;
    full_name: string | null;
    name: string | null;
  }> = await knex
    .select(
      "l.product_variant_id as variant_id",
      "v.full_name",
      "v.name"
    )
    .from("quickbooks_catalog_qb_vendor_product_product_variant as l")
    .join("qb_vendor as v", "v.id", "l.qb_vendor_id")
    .whereNull("l.deleted_at")
    .whereNull("v.deleted_at")
    .modify((qb: any) => {
      if (variantIds) qb.whereIn("l.product_variant_id", variantIds);
    });

  for (const r of rows) {
    const nm = (r.full_name || r.name || "").trim();
    if (nm && !map.has(r.variant_id)) map.set(r.variant_id, nm);
  }
  return map;
}
