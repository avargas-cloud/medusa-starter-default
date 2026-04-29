/**
 * POST /admin/landing-costs/:id/recalculate
 *
 * Distributes commission, freight (by CBM), and tariff (by cost) across
 * every line and persists the breakdown. Always overwrites prior values.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { computeLandedCosts } from "../../_lib/calc";
import {
  getLandingCostsService,
  resolveKnex,
} from "../../_lib/service-resolver";

interface HeaderRow {
  id: string;
  commission_mode: "percent" | "fixed";
  commission_rate_bps: number;
  commission_amount_cents: number;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
}

interface LineRow {
  id: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };

  const knex = resolveKnex(req);
  const service = getLandingCostsService(req);

  const headerResult = await knex.raw(
    `SELECT id, commission_mode, commission_rate_bps, commission_amount_cents,
            freight_included, freight_amount_cents,
            tariff_included, tariff_amount_cents
     FROM landing_cost
     WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const header = (headerResult.rows[0] ?? null) as HeaderRow | null;
  if (!header) {
    return res
      .status(404)
      .json({ error: "Landing cost not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT id, qty, unit_cost_cents, cbm_per_unit
     FROM landing_cost_line
     WHERE landing_cost_id = ? AND deleted_at IS NULL`,
    [id]
  );
  const lines = linesResult.rows as LineRow[];

  if (lines.length === 0) {
    return res
      .status(422)
      .json({ error: "No lines to recalculate", code: "no_lines" });
  }

  const breakdowns = computeLandedCosts(header, lines);

  for (const b of breakdowns) {
    await knex.raw(
      `UPDATE landing_cost_line
       SET commission_per_unit_cents = ?,
           freight_per_unit_cents    = ?,
           tariff_per_unit_cents     = ?,
           landed_unit_cost_cents    = ?,
           updated_at                = NOW()
       WHERE id = ?`,
      [
        b.commission_per_unit_cents,
        b.freight_per_unit_cents,
        b.tariff_per_unit_cents,
        b.landed_unit_cost_cents,
        b.id,
      ]
    );
  }

  await service.updateLandingCosts({
    selector: { id },
    data: { recalculated_at: new Date() },
  });

  return res.json({ recalculated: true, lines: breakdowns.length });
}
