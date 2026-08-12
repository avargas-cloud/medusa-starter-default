/**
 * GET /admin/qb-catalog/vendors/:id/product-variants
 *
 * Returns the product_variant IDs whose PRODUCT-level "preferred vendor"
 * (product.metadata.vendor_list_id / vendor_full_name) is this qb_vendor.
 *
 * This is the authoritative "products of this vendor" source used by the
 * Factory Order "By Manufacturer" modal. It intentionally matches on the
 * product-level QuickBooks vendor metadata (what the Edit Item UI shows as
 * "Preferred Vendor") and NOT on the Meili `inventory.vendorName` field —
 * that value derives from the variant↔qb_vendor link table, which is a
 * different (often stale) association and mismatches the manufacturer.
 *
 * Matching is by qb_list_id first (id-based, case-proof), with full_name /
 * name as fallbacks for products missing the list id.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import {
  vendorFullNameSql,
  vendorListIdSql,
} from "../../../../../../lib/vendor-metadata/keys";

type KnexRaw = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const vendorId = req.params.id;
  if (!vendorId) {
    return res.status(400).json({ error: "vendor id required" });
  }

  const knex = (
    req.scope as unknown as { resolve: (k: string) => KnexRaw }
  ).resolve("__pg_connection__");

  const vendorRows = await knex
    .raw(
      `SELECT qb_list_id, full_name, name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [vendorId]
    )
    .then(
      (r) =>
        r.rows as Array<{
          qb_list_id: string | null;
          full_name: string | null;
          name: string | null;
        }>
    );

  const vendor = vendorRows[0];
  if (!vendor) {
    return res.json({ variant_ids: [], count: 0 });
  }

  const listId = vendor.qb_list_id ?? "";
  const fullName = vendor.full_name ?? "";
  const shortName = vendor.name ?? "";

  if (!listId && !fullName && !shortName) {
    return res.json({ variant_ids: [], count: 0 });
  }

  const rows = await knex
    .raw(
      `SELECT DISTINCT pv.id AS variant_id
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       WHERE pv.deleted_at IS NULL
         AND (
           (? <> '' AND ${vendorListIdSql("p")} = ?)
           OR (? <> '' AND ${vendorFullNameSql("p")} = ?)
           OR (? <> '' AND ${vendorFullNameSql("p")} = ?)
         )`,
      [listId, listId, fullName, fullName, shortName, shortName]
    )
    .then((r) => r.rows as Array<{ variant_id: string }>);

  const variantIds = rows.map((row) => row.variant_id);
  return res.json({ variant_ids: variantIds, count: variantIds.length });
}
