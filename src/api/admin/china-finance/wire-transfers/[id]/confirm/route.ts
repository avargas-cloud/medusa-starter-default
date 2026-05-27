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
import { randomUUID } from "crypto";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const confirmSchema = z.object({
  received_amount_cents: z.number().int().min(0),
  confirmed_date: z.string().date(),
  sent_date: z.string().date().optional(),
  bank_fee_included_cents: z.number().int().min(0).optional(),
});

// Mirror of the helper in [id]/route.ts — kept local to this file to avoid
// reaching across the api/ tree. Reconciles the synthetic bank_fee bill row
// attached to a wire (insert / update / delete based on the target amount).
async function reconcileWireBankFee(
  knex: Knex,
  wireId: string,
  targetCents: number,
  sentDate: string | null
): Promise<void> {
  const { rows: existing } = await knex.raw(
    `SELECT id FROM china_finance_bill
       WHERE wire_transfer_id = ? AND document_type = 'bank_fee'
       ORDER BY sort_order ASC
       LIMIT 1`,
    [wireId]
  ) as { rows: Array<{ id: string }> };
  const current = existing[0];

  if (targetCents === 0) {
    if (!current) return;
    await knex.raw(
      `DELETE FROM china_wire_transfer_application
         WHERE wire_transfer_id = ? AND bill_id = ?`,
      [wireId, current.id]
    );
    await knex.raw(`DELETE FROM china_finance_bill WHERE id = ?`, [current.id]);
    return;
  }

  if (current) {
    await knex.raw(
      `UPDATE china_finance_bill
         SET amount_cents = ?, updated_at = now()
       WHERE id = ?`,
      [targetCents, current.id]
    );
    await knex.raw(
      `UPDATE china_wire_transfer_application
         SET applied_cents = ?
       WHERE wire_transfer_id = ? AND bill_id = ?`,
      [targetCents, wireId, current.id]
    );
    return;
  }

  const { rows: maxSortRows } = await knex.raw(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_so FROM china_finance_bill`
  ) as { rows: [{ max_so: number }] };
  const { rows: maxAppRows } = await knex.raw(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_so
       FROM china_wire_transfer_application WHERE wire_transfer_id = ?`,
    [wireId]
  ) as { rows: [{ max_so: number }] };

  const feeBillId = randomUUID();
  await knex.raw(
    `INSERT INTO china_finance_bill
       (id, type, sort_order, wire_transfer_id, document_type,
        payee, description, amount_cents, document_date)
     VALUES (?, 'bank_fee', ?, ?, 'bank_fee',
             'Bank Fee', ?, ?, ?)`,
    [
      feeBillId,
      maxSortRows[0].max_so + 1,
      wireId,
      `Wire transfer bank fee from wire ${wireId}`,
      targetCents,
      sentDate,
    ]
  );
  await knex.raw(
    `INSERT INTO china_wire_transfer_application
       (id, wire_transfer_id, bill_id, applied_cents, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), wireId, feeBillId, targetCents, maxAppRows[0].max_so + 1]
  );
}

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
  const { received_amount_cents, confirmed_date, sent_date, bank_fee_included_cents } = parsed.data;

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

  if (bank_fee_included_cents !== undefined && id) {
    const wireRow = rows[0] as { sent_date: string | null };
    await reconcileWireBankFee(knex, id, bank_fee_included_cents, wireRow.sent_date);
  }

  return res.json({ wire_transfer: rows[0] });
};
