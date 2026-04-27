/**
 * POST /admin/purchasing/variants/:id/available-since
 *
 * Sets pv.metadata.available_since for a single variant. This is the manual
 * override that tells the Daily Sales Engine "treat this variant as alive
 * since X" — empty months between X and now then count as real zeros and
 * pull the weighted Pareto revenue down (instead of being skipped as pre-life).
 *
 * Body: { available_since: "YYYY-MM-DD" | null }
 *   • YYYY-MM-DD → set the override
 *   • null       → clear (engine falls back to first sale date)
 *
 * Side effect: recalculates the snapshot row for this variant so the Pareto
 * UI reflects the change without waiting for the nightly job.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { recalculateForVariants } from "../../../../../../services/purchasing/snapshot.service";
import { withDb } from "../../../_lib/db";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const variantId = (req.params as { id?: string }).id;
  if (!variantId) {
    return res.status(400).json({ error: "missing variant id" });
  }

  const body = (req.body ?? {}) as { available_since?: string | null };
  const raw = body.available_since;

  // Validate input
  let next: string | null;
  if (raw === null || raw === undefined || raw === "") {
    next = null;
  } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    next = raw;
  } else {
    return res.status(400).json({
      error: "available_since must be YYYY-MM-DD or null",
    });
  }

  return withDb(async (db) => {
    // Confirm variant exists
    const { rows } = await db.query<{ id: string; metadata: object | null }>(
      `SELECT id, metadata FROM product_variant
       WHERE id = $1 AND deleted_at IS NULL`,
      [variantId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "variant not found" });
    }

    if (next === null) {
      // Clear the key from metadata.
      await db.query(
        `UPDATE product_variant
         SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'available_since')
         WHERE id = $1`,
        [variantId]
      );
    } else {
      await db.query(
        `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('available_since', $2::text)
         WHERE id = $1`,
        [variantId, next]
      );
    }

    // Refresh this variant's snapshot row (and any primaries that link to it
    // via product_alternative — handled inside recalculateForVariants).
    try {
      await recalculateForVariants([variantId]);
    } catch (e) {
      console.error(
        `[available-since] recalc failed for ${variantId}:`,
        (e as Error).message
      );
    }

    return res.json({ variant_id: variantId, available_since: next });
  });
}
