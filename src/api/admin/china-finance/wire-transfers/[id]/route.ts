/**
 * GET   /admin/china-finance/wire-transfers/:id
 *   Returns wire transfer detail with its bills.
 *
 * PATCH /admin/china-finance/wire-transfers/:id
 *   Updates wire (notes, sent_date, wire_amount_cents).
 *
 * DELETE /admin/china-finance/wire-transfers/:id
 *   Deletes a wire created by mistake. Normal bill rows are released back to
 *   pending; synthetic rows owned by the wire are deleted.
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
    `WITH paid AS (
       SELECT bill_id, SUM(applied_cents)::integer AS paid_cents
       FROM china_wire_transfer_application
       GROUP BY bill_id
     )
     SELECT
       cfb.*,
       cwta.applied_cents AS amount_cents,
       cfb.amount_cents AS original_amount_cents,
       GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents
     FROM china_wire_transfer_application cwta
     JOIN china_finance_bill cfb ON cfb.id = cwta.bill_id
     LEFT JOIN paid ON paid.bill_id = cfb.id
     WHERE cwta.wire_transfer_id = ?
     ORDER BY cwta.sort_order ASC, cfb.sort_order ASC`,
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

export const DELETE = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { id } = req.params;

  const { rows: wires } = await knex.raw(
    `SELECT id FROM china_wire_transfer WHERE id = ?`,
    [id]
  ) as { rows: Array<{ id: string }> };

  if (wires.length === 0) {
    return res.status(404).json({ message: "Wire transfer not found" });
  }

  await knex.raw(`BEGIN`);
  try {
    await knex.raw(
      `DELETE FROM china_finance_bill
       WHERE wire_transfer_id IS NULL
         AND type = 'bank_fee'
         AND description = ?`,
      [`Wire transfer bank fee from wire ${id}`]
    );

    await knex.raw(
      `DELETE FROM china_finance_bill
       WHERE wire_transfer_id = ?
         AND type IN ('opening_balance', 'bank_fee')`,
      [id]
    );

    await knex.raw(
      `UPDATE china_finance_bill
       SET wire_transfer_id = NULL,
           updated_at = now()
       WHERE wire_transfer_id = ?`,
      [id]
    );

    await knex.raw(
      `DELETE FROM china_wire_transfer_application
       WHERE wire_transfer_id = ?`,
      [id]
    );

    await knex.raw(
      `DELETE FROM china_wire_transfer WHERE id = ?`,
      [id]
    );

    await knex.raw(`COMMIT`);
    return res.json({ success: true });
  } catch (err) {
    await knex.raw(`ROLLBACK`);
    throw err;
  }
};
