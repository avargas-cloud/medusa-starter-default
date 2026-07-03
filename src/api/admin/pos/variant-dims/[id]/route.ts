/**
 * PATCH /admin/pos/variant-dims/:id
 *
 * Saves per-unit shipping dimensions for one variant and recomputes CBM.
 *
 * Source of truth = product_variant.metadata.shipping_{length,width,height,weight}
 * (exact, inches / lb). CBM (m³) = length × width × height × 0.000016387064
 * (0.0254³ exactly). The exact values are ALSO mirrored to the native
 * product_variant + inventory_item columns so UPS shipping (which reads
 * inventory_item first, then variant native) reflects the edit precisely.
 *
 * All writes run in a single transaction so dims and cbm never diverge.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

/** Cubic inches → cubic meters. 0.0254³ is exact (1 in = 0.0254 m by definition). */
const IN3_TO_M3 = 0.000016387064;

type Trx = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type KnexInstance = Trx & {
  transaction: <T>(cb: (trx: Trx) => Promise<T>) => Promise<T>;
};

const bodySchema = z.object({
  length_in: z.number().finite().min(0).max(10000),
  width_in: z.number().finite().min(0).max(10000),
  height_in: z.number().finite().min(0).max(10000),
  weight_lb: z.number().finite().min(0).max(100000),
  // Explicit CBM (m³). When provided, it is stored as-is (auto-derived on the
  // client, or a manual override). When omitted, the server computes it from dims.
  cbm: z.number().finite().min(0).max(1000).nullable().optional(),
});

interface RawDimRow {
  id: string;
  sku: string | null;
  variant_title: string | null;
  product_title: string | null;
  length: string | number | null;
  width: string | number | null;
  height: string | number | null;
  weight: string | number | null;
  cbm: string | number | null;
}

/** Coerce a JSONB text value to a finite number, else null (never throws). */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid dimensions",
      code: "invalid_body",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const { length_in, width_in, height_in, weight_lb } = parsed.data;

  // Auto CBM from dims: only when all three are real (> 0), else null.
  const computedCbm =
    length_in > 0 && width_in > 0 && height_in > 0
      ? length_in * width_in * height_in * IN3_TO_M3
      : null;
  // An explicit cbm in the body (client-derived or a manual override) wins; when
  // omitted we fall back to the dimension-derived value. null clears it, so landing
  // cost treats the line as "no CBM" instead of using a stale value.
  const cbm = parsed.data.cbm !== undefined ? parsed.data.cbm : computedCbm;

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  const updated = await knex.transaction(async (trx) => {
    const variantUpdate = await trx.raw(
      `UPDATE product_variant
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'shipping_length', ?::float,
                'shipping_width',  ?::float,
                'shipping_height', ?::float,
                'shipping_weight', ?::float,
                'cbm',             ?::float
              ),
              length = ?::float,
              width  = ?::float,
              height = ?::float,
              weight = ?::float,
              updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL
        RETURNING id`,
      [
        length_in,
        width_in,
        height_in,
        weight_lb,
        cbm,
        length_in,
        width_in,
        height_in,
        weight_lb,
        id,
      ]
    );

    if (variantUpdate.rows.length === 0) {
      return null;
    }

    // Mirror exact dims to the linked inventory_item(s) — UPS reads these first.
    await trx.raw(
      `UPDATE inventory_item ii
          SET length = ?::numeric,
              width  = ?::numeric,
              height = ?::numeric,
              weight = ?::numeric,
              updated_at = NOW()
         FROM product_variant_inventory_item pvii
        WHERE pvii.inventory_item_id = ii.id
          AND pvii.variant_id = ?
          AND pvii.deleted_at IS NULL
          AND ii.deleted_at IS NULL`,
      [length_in, width_in, height_in, weight_lb, id]
    );

    const refreshed = await trx.raw(
      `SELECT
          v.id,
          v.sku,
          v.title AS variant_title,
          p.title AS product_title,
          v.metadata->>'shipping_length' AS length,
          v.metadata->>'shipping_width'  AS width,
          v.metadata->>'shipping_height' AS height,
          v.metadata->>'shipping_weight' AS weight,
          v.metadata->>'cbm'             AS cbm
         FROM product_variant v
         JOIN product p ON p.id = v.product_id
        WHERE v.id = ?`,
      [id]
    );

    const raw = refreshed.rows[0] as RawDimRow | undefined;
    if (!raw) return null;
    return {
      id: raw.id,
      sku: raw.sku,
      variant_title: raw.variant_title,
      product_title: raw.product_title,
      length: toNum(raw.length),
      width: toNum(raw.width),
      height: toNum(raw.height),
      weight: toNum(raw.weight),
      cbm: toNum(raw.cbm),
    };
  });

  if (!updated) {
    res.status(404).json({ error: "Variant not found", code: "not_found" });
    return;
  }

  res.json({ variant_dim: updated });
}
