/**
 * POST /admin/landing-costs/:id/lines
 *
 * Adds an item to the calculator. Two modes:
 *   - Linked variant: pass product_variant_id; SKU/description/cost/MPN/CBM
 *     are pre-filled from product_variant + variant.metadata, but the body
 *     can override any of them. Description defaults to
 *     metadata.purchase_description, falling back to variant.title.
 *   - Manual:        omit product_variant_id; sku + description + qty +
 *                    unit_cost_cents are required from the body.
 *
 * The added row never affects inventory, QB, or any other module.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../../purchase-orders/_lib/format";
import {
  getLandingCostsService,
  resolveKnex,
} from "../../_lib/service-resolver";

const bodySchema = z.object({
  product_variant_id: z.string().nullish(),
  sku: z.string().max(200).optional(),
  mpn: z.string().max(200).nullish(),
  description: z.string().max(500).optional(),
  qty: z.number().int().min(1).default(1),
  unit_cost_cents: z.number().int().min(0).optional(),
  cbm_per_unit: z.number().min(0).max(100).nullish(),
});

interface VariantRow {
  id: string;
  sku: string | null;
  title: string | null;
  metadata: Record<string, unknown> | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getLandingCostsService(req);
  const existing = (await service
    .retrieveLandingCost(id)
    .catch(() => null)) as unknown as { id: string } | null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Landing cost not found", code: "not_found" });
  }

  let sku = body.sku ?? "";
  let description = body.description ?? "";
  let mpn: string | null = body.mpn ?? null;
  let unitCostCents = body.unit_cost_cents ?? 0;
  let cbmPerUnit: number | null = body.cbm_per_unit ?? null;

  if (body.product_variant_id) {
    const knex = resolveKnex(req);
    const result = await knex.raw(
      `SELECT id, sku, title, metadata
       FROM product_variant
       WHERE id = ? AND deleted_at IS NULL`,
      [body.product_variant_id]
    );
    const variant = (result.rows[0] ?? null) as VariantRow | null;
    if (!variant) {
      return res
        .status(404)
        .json({ error: "Variant not found", code: "variant_not_found" });
    }
    const meta = variant.metadata ?? {};

    if (!sku) sku = variant.sku ?? "";
    if (!description) {
      const purchaseDesc =
        typeof meta.purchase_description === "string"
          ? (meta.purchase_description as string)
          : null;
      description = purchaseDesc?.trim() || variant.title?.trim() || sku;
    }
    if (mpn === null && typeof meta.mpn === "string") mpn = meta.mpn as string;
    if (cbmPerUnit == null && meta.cbm != null) {
      const n = Number(meta.cbm);
      cbmPerUnit = isNaN(n) ? null : n;
    }
    if (body.unit_cost_cents == null) {
      const avg = meta.qb_avg_cost;
      if (typeof avg === "number" && avg > 0) {
        unitCostCents = Math.round(avg * 100);
      }
    }
  }

  // Blank-line mode: when no variant is linked and the user did not provide
  // a SKU, create a placeholder row that they can fill in inline.
  if (!sku) sku = "—";
  if (!description) description = "(new item)";

  const created = (await service.createLandingCostLines({
    landing_cost_id: id,
    product_variant_id: body.product_variant_id ?? null,
    sku,
    mpn,
    description,
    qty: body.qty,
    unit_cost_cents: unitCostCents,
    cbm_per_unit: cbmPerUnit,
    commission_per_unit_cents: 0,
    freight_per_unit_cents: 0,
    tariff_per_unit_cents: 0,
    landed_unit_cost_cents: unitCostCents,
  })) as unknown as { id: string };

  return res.status(201).json({ landing_cost_line: created });
}
