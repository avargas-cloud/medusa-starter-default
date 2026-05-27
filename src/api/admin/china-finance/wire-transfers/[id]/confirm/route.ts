/**
 * PATCH /admin/china-finance/wire-transfers/:id/confirm
 *
 * Marks a wire transfer as confirmed (received by China).
 * Body: { received_amount_cents: number, confirmed_date: string }
 * Computes bank_fee_cents = wire_amount_cents - received_amount_cents.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const confirmSchema = z.object({
  received_amount_cents: z.number().int().min(0),
  confirmed_date: z.string().date(),
  sent_date: z.string().date().optional(),
});

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { id } = req.params;
  const { received_amount_cents, confirmed_date, sent_date } = parsed.data;

  const { rows: existing } = await knex.raw(
    `SELECT id, status, wire_amount_cents FROM china_wire_transfer WHERE id = ?`, [id]
  ) as { rows: Array<{ id: string; status: string; wire_amount_cents: number }> };

  const wire = existing[0];
  if (!wire) return res.status(404).json({ message: "Wire transfer not found" });
  if (wire.status === "confirmed") {
    return res.status(400).json({ message: "Wire transfer already confirmed" });
  }

  const bank_fee_cents = wire.wire_amount_cents - received_amount_cents;

  // sent_date is optional — drafts are scheduled with an estimated date,
  // and the actual send date may differ. When the caller passes it, we
  // overwrite the estimate; otherwise the original draft date stays.
  const setSentDate = sent_date !== undefined;
  const { rows } = await knex.raw(
    `UPDATE china_wire_transfer
       SET status = 'confirmed',
           received_amount_cents = ?,
           bank_fee_cents = ?,
           confirmed_date = ?,
           ${setSentDate ? "sent_date = ?," : ""}
           updated_at = now()
     WHERE id = ?
     RETURNING *`,
    setSentDate
      ? [received_amount_cents, bank_fee_cents, confirmed_date, sent_date, id]
      : [received_amount_cents, bank_fee_cents, confirmed_date, id]
  ) as { rows: [Record<string, unknown>] };

  return res.json({ wire_transfer: rows[0] });
};
