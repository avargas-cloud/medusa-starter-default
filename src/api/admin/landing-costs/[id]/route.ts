/**
 * src/api/admin/landing-costs/[id]/route.ts
 *
 * GET    /admin/landing-costs/:id  — header + lines
 * PATCH  /admin/landing-costs/:id  — update header (commission/freight/tariff/notes/reference_id)
 * DELETE /admin/landing-costs/:id  — soft delete
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../purchase-orders/_lib/format";
import { getLandingCostsService, resolveKnex } from "../_lib/service-resolver";

// ── Schema ───────────────────────────────────────────────────────────────────

const patchBodySchema = z
  .object({
    reference_id: z.string().max(200).nullish(),
    notes: z.string().max(2000).nullish(),
    commission_mode: z.enum(["percent", "fixed"]).optional(),
    commission_rate_bps: z.number().int().min(0).max(100_000).optional(),
    commission_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
    commission_invoice_number: z.string().max(200).nullish(),
    freight_included: z.boolean().optional(),
    freight_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
    freight_invoice_number: z.string().max(200).nullish(),
    tariff_included: z.boolean().optional(),
    tariff_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
    tariff_number: z.string().max(200).nullish(),
  })
  .partial();

// ── Types ────────────────────────────────────────────────────────────────────

interface LandingCostDetailRow {
  id: string;
  reference_id: string | null;
  notes: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  commission_invoice_number: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  freight_invoice_number: string | null;
  tariff_included: boolean;
  tariff_amount_cents: number;
  tariff_number: string | null;
  recalculated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LandingCostLineRow {
  id: string;
  landing_cost_id: string;
  product_variant_id: string | null;
  sku: string;
  mpn: string | null;
  description: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const headerResult = await knex.raw(
    `SELECT * FROM landing_cost WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const header = (headerResult.rows[0] ?? null) as LandingCostDetailRow | null;
  if (!header) {
    return res
      .status(404)
      .json({ error: "Landing cost not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT * FROM landing_cost_line
     WHERE landing_cost_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );
  const lines = linesResult.rows as LandingCostLineRow[];

  const total_landed_cents = lines.reduce(
    (s, l) => s + l.landed_unit_cost_cents * l.qty,
    0
  );

  return res.json({ landing_cost: { ...header, total_landed_cents, lines } });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };

  const parsed = patchBodySchema.safeParse(req.body);
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

  await service.updateLandingCosts({
    selector: { id },
    data: body,
  });

  // Re-read so we return the fresh row
  const knex = resolveKnex(req);
  const headerResult = await knex.raw(
    `SELECT * FROM landing_cost WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const header = (headerResult.rows[0] ?? null) as LandingCostDetailRow | null;

  return res.json({ landing_cost: header });
}

// ── DELETE — hard delete (the row + cascading lines are removed for good) ────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  // FK on landing_cost_line cascades, so a single DELETE clears both tables.
  const result = (await knex.raw(
    `DELETE FROM landing_cost WHERE id = ? RETURNING id`,
    [id]
  )) as { rows: Array<{ id: string }> };

  if (result.rows.length === 0) {
    return res
      .status(404)
      .json({ error: "Landing cost not found", code: "not_found" });
  }

  return res.json({ id, deleted: true, hard: true });
}
