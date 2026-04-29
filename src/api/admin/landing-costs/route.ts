/**
 * src/api/admin/landing-costs/route.ts
 *
 * GET  /admin/landing-costs  — list with summary aggregates
 * POST /admin/landing-costs  — create empty calculator
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../purchase-orders/_lib/format";
import { getLandingCostsService, resolveKnex } from "./_lib/service-resolver";

// ── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createBodySchema = z.object({
  reference_id: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

// ── Types ────────────────────────────────────────────────────────────────────

interface LandingCostListRow {
  id: string;
  reference_id: string | null;
  notes: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
  recalculated_at: string | null;
  created_at: string;
  line_count: string;
  total_landed_cents: string | null;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { limit, offset } = parsed.data;

  const knex = resolveKnex(req);

  const countResult = await knex.raw(
    `SELECT COUNT(*) AS total FROM landing_cost lc WHERE lc.deleted_at IS NULL`
  );
  const count = Number((countResult.rows[0] as { total: string }).total);

  const dataResult = await knex.raw(
    `SELECT
       lc.id,
       lc.reference_id,
       lc.notes,
       lc.commission_mode,
       lc.commission_rate_bps,
       lc.commission_amount_cents,
       lc.freight_included,
       lc.freight_amount_cents,
       lc.tariff_included,
       lc.tariff_amount_cents,
       lc.recalculated_at,
       lc.created_at,
       COALESCE(agg.line_count, 0)         AS line_count,
       COALESCE(agg.total_landed_cents, 0) AS total_landed_cents
     FROM landing_cost lc
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS line_count,
         SUM(lcl.landed_unit_cost_cents * lcl.qty) AS total_landed_cents
       FROM landing_cost_line lcl
       WHERE lcl.landing_cost_id = lc.id AND lcl.deleted_at IS NULL
     ) agg ON TRUE
     WHERE lc.deleted_at IS NULL
     ORDER BY lc.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`
  );

  const rows = (dataResult.rows as LandingCostListRow[]).map((r) => ({
    ...r,
    line_count: Number(r.line_count),
    total_landed_cents: Number(r.total_landed_cents ?? 0),
  }));

  return res.json({ landing_costs: rows, count });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getLandingCostsService(req);

  const created = (await service.createLandingCosts({
    reference_id: body.reference_id ?? null,
    notes: body.notes ?? null,
  })) as unknown as { id: string };

  return res.status(201).json({ landing_cost: { ...created, lines: [] } });
}
