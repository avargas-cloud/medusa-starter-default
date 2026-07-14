/**
 * GET /admin/purchasing/china-variants
 *
 * Returns the product_variant IDs of every product sourced through the China
 * purchasing agent (`product.metadata.is_sourced_via_agent`).
 *
 * Mirrors the shape of GET /admin/qb-catalog/vendors/:id/product-variants so a
 * caller can swap between "this vendor's catalog" and "the China catalog" without
 * changing its hydration path. The purchase-order "By Vendor" picker uses this
 * one when the PO's vendor is flagged as the China agent: a PO to the agent is
 * not a PO for the agent's own catalog — it buys the whole China assortment.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Array<{ variant_id: string }> }>;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const knex = (
    req.scope as unknown as { resolve: (k: string) => KnexRaw }
  ).resolve("__pg_connection__");

  // Cast to boolean, so both `true` and the string `'true'` match — the flag is
  // written from several places (widget, bulk script, POS product update).
  const rows = await knex
    .raw(
      `SELECT DISTINCT pv.id AS variant_id
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
        WHERE pv.deleted_at IS NULL
          AND COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) = true`
    )
    .then((r) => r.rows);

  const variantIds = rows.map((row) => row.variant_id);
  return res.json({ variant_ids: variantIds, count: variantIds.length });
}
