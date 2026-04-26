/**
 * POST /admin/purchasing/alternatives/merge
 *
 * Merges a primary product B into primary product A.
 * B and all of B's active alternatives (C, D, …) become alternatives of A.
 * B's existing primary links are deactivated so B is no longer a primary.
 *
 * Body: { primary_variant_id: string, merge_variant_id: string }
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { withDb } from "../../_lib/db";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const body = req.body as {
    primary_variant_id?: string;
    merge_variant_id?: string;
  };

  const { primary_variant_id, merge_variant_id } = body;

  if (!primary_variant_id || !merge_variant_id) {
    return res
      .status(400)
      .json({ error: "primary_variant_id and merge_variant_id are required" });
  }
  if (primary_variant_id === merge_variant_id) {
    return res.status(400).json({ error: "Cannot merge a product with itself" });
  }

  return withDb(async (db) => {
    // Verify both variants exist
    const check = await db.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [[primary_variant_id, merge_variant_id]]
    );
    if ((check.rowCount ?? 0) < 2) {
      return res.status(404).json({ error: "One or both variant IDs not found" });
    }

    // Fetch all active alternatives of B (the merge source)
    const bAlts = await db.query<{ alt_variant_id: string }>(
      `SELECT alt_variant_id FROM product_alternative
       WHERE primary_variant_id = $1 AND is_active = true AND deleted_at IS NULL`,
      [merge_variant_id]
    );

    // All variants to add as alternatives of A: B itself + B's alts (C, D, …)
    const toAdd = [
      merge_variant_id,
      ...bAlts.rows.map((r) => r.alt_variant_id),
    ].filter((id) => id !== primary_variant_id);

    for (const alt_variant_id of toAdd) {
      const id = `palt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await db.query(
        `INSERT INTO product_alternative
           (id, primary_variant_id, alt_variant_id, priority, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, 1, true, now(), now())
         ON CONFLICT (primary_variant_id, alt_variant_id)
         DO UPDATE SET is_active = true, updated_at = now()`,
        [id, primary_variant_id, alt_variant_id]
      );
    }

    // Deactivate B's primary links — B is no longer a primary
    if ((bAlts.rowCount ?? 0) > 0) {
      await db.query(
        `UPDATE product_alternative
         SET is_active = false, updated_at = now()
         WHERE primary_variant_id = $1 AND is_active = true AND deleted_at IS NULL`,
        [merge_variant_id]
      );
    }

    // Resolve SKUs for the response
    const skuRows = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [toAdd]
    );
    const skuMap = Object.fromEntries(skuRows.rows.map((r) => [r.id, r.sku]));

    return res.status(200).json({
      ok: true,
      merged: toAdd.map((id) => ({ variant_id: id, sku: skuMap[id] ?? id })),
    });
  });
}
