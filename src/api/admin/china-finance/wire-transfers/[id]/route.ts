/**
 * GET   /admin/china-finance/wire-transfers/:id
 *   Returns wire transfer detail with its bills.
 *
 * PATCH /admin/china-finance/wire-transfers/:id
 *   Updates wire (notes, sent_date, wire_amount_cents).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const updateWireSchema = z.object({
  sent_date: z.string().date().optional(),
  wire_amount_cents: z.number().int().min(1).optional(),
  notes: z.string().max(1000).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { id } = req.params;

  const { rows: wires } = await knex.raw(
    `SELECT * FROM china_wire_transfer WHERE id = ?`, [id]
  ) as { rows: Array<Record<string, unknown>> };

  if (wires.length === 0) return res.status(404).json({ message: "Wire transfer not found" });

  const { rows: bills } = await knex.raw(
    `SELECT * FROM china_finance_bill WHERE wire_transfer_id = ? ORDER BY sort_order ASC`,
    [id]
  ) as { rows: Array<Record<string, unknown>> };

  return res.json({ wire_transfer: wires[0], bills });
};

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = updateWireSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { id } = req.params;
  const { sent_date, wire_amount_cents, notes } = parsed.data;

  const setClauses: string[] = ["updated_at = now()"];
  const bindings: unknown[] = [];

  if (sent_date !== undefined) { setClauses.push("sent_date = ?"); bindings.push(sent_date); }
  if (wire_amount_cents !== undefined) { setClauses.push("wire_amount_cents = ?"); bindings.push(wire_amount_cents); }
  if (notes !== undefined) { setClauses.push("notes = ?"); bindings.push(notes); }
  bindings.push(id);

  const { rows } = await knex.raw(
    `UPDATE china_wire_transfer SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    bindings
  ) as { rows: Array<Record<string, unknown>> };

  if (rows.length === 0) return res.status(404).json({ message: "Wire transfer not found" });

  return res.json({ wire_transfer: rows[0] });
};
