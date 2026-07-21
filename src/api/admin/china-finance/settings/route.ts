/**
 * GET   /admin/china-finance/settings
 * PATCH /admin/china-finance/settings
 *
 * payment_day_of_week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
 * estimate_strategy:   'past_due_only' | 'due_before_next_payment'
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const updateSettingsSchema = z.object({
  payment_day_of_week: z.number().int().min(0).max(6).optional(),
  estimate_strategy: z.enum(["past_due_only", "due_before_next_payment"]).optional(),
  opening_balance_cents: z.number().int().optional(),
  opening_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  credit_limit_cents: z.number().int().min(0).optional(),
  cl_include_balance: z.boolean().optional(),
  cl_include_inventory: z.boolean().optional(),
  cl_include_production: z.boolean().optional(),
  exposure_limit_cents: z.number().int().min(0).optional(),
  exposure_include_production: z.boolean().optional(),
  // Drift check: the agent's commission rate (basis points, 1500 = 15%) and the
  // tolerance (cents) that absorbs the agent's own rounding before flagging.
  agent_commission_rate_bps: z.number().int().min(0).max(100_000).optional(),
  commission_tolerance_cents: z.number().int().min(0).max(100_000).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields provided" });

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { rows } = await knex.raw(
    `SELECT * FROM china_finance_settings WHERE id = 'singleton'`
  ) as { rows: [Record<string, unknown>] };

  return res.json({ settings: rows[0] ?? null });
};

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { payment_day_of_week, estimate_strategy, opening_balance_cents, opening_balance_date,
          credit_limit_cents, cl_include_balance, cl_include_inventory, cl_include_production,
          exposure_limit_cents, exposure_include_production,
          agent_commission_rate_bps, commission_tolerance_cents } = parsed.data;

  const setClauses: string[] = ["updated_at = now()"];
  const bindings: unknown[] = [];

  if (payment_day_of_week !== undefined) {
    setClauses.push("payment_day_of_week = ?");
    bindings.push(payment_day_of_week);
  }
  if (estimate_strategy !== undefined) {
    setClauses.push("estimate_strategy = ?");
    bindings.push(estimate_strategy);
  }
  if (opening_balance_cents !== undefined) {
    setClauses.push("opening_balance_cents = ?");
    bindings.push(opening_balance_cents);
  }
  if (opening_balance_date !== undefined) {
    setClauses.push("opening_balance_date = ?");
    bindings.push(opening_balance_date);
  }
  if (credit_limit_cents !== undefined) {
    setClauses.push("credit_limit_cents = ?");
    bindings.push(credit_limit_cents);
  }
  if (cl_include_balance !== undefined) {
    setClauses.push("cl_include_balance = ?");
    bindings.push(cl_include_balance);
  }
  if (cl_include_inventory !== undefined) {
    setClauses.push("cl_include_inventory = ?");
    bindings.push(cl_include_inventory);
  }
  if (cl_include_production !== undefined) {
    setClauses.push("cl_include_production = ?");
    bindings.push(cl_include_production);
  }
  if (exposure_limit_cents !== undefined) {
    setClauses.push("exposure_limit_cents = ?");
    bindings.push(exposure_limit_cents);
  }
  if (exposure_include_production !== undefined) {
    setClauses.push("exposure_include_production = ?");
    bindings.push(exposure_include_production);
  }
  if (agent_commission_rate_bps !== undefined) {
    setClauses.push("agent_commission_rate_bps = ?");
    bindings.push(agent_commission_rate_bps);
  }
  if (commission_tolerance_cents !== undefined) {
    setClauses.push("commission_tolerance_cents = ?");
    bindings.push(commission_tolerance_cents);
  }
  bindings.push("singleton");

  const { rows } = await knex.raw(
    `UPDATE china_finance_settings SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    bindings
  ) as { rows: [Record<string, unknown>] };

  return res.json({ settings: rows[0] });
};
