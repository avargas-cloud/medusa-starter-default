/**
 * GET  /admin/china-finance/wire-transfers
 *   Lists all wire transfers ordered by sent_date DESC.
 *
 * POST /admin/china-finance/wire-transfers
 *   Creates a new wire transfer.
 *   Assigns selected bills to the wire.
 *   If bank_fee_from_previous_cents is provided, creates a bank_fee bill
 *   row (dated from the previous wire) and marks it as covered by this wire.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const createWireSchema = z.object({
  bill_ids: z.array(z.string()).min(1),
  wire_amount_cents: z.number().int().min(1),
  sent_date: z.string().date(),
  bank_fee_from_previous_cents: z.number().int().min(0).optional(),
  notes: z.string().max(1000).optional(),
});

// ── GET ───────────────────────────────────────────────────────────────────────
export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { rows } = await knex.raw(`
    SELECT
      cwt.*,
      COUNT(cfb.id)::int             AS bill_count,
      SUM(cfb.amount_cents)::bigint  AS covered_amount_cents
    FROM china_wire_transfer cwt
    LEFT JOIN china_finance_bill cfb ON cfb.wire_transfer_id = cwt.id
    GROUP BY cwt.id
    ORDER BY cwt.sent_date DESC NULLS LAST, cwt.created_at DESC
  `) as { rows: Array<Record<string, unknown>> };

  return res.json({ wire_transfers: rows, count: rows.length });
};

// ── POST ──────────────────────────────────────────────────────────────────────
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = createWireSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const {
    bill_ids,
    wire_amount_cents,
    sent_date,
    bank_fee_from_previous_cents,
    notes,
  } = parsed.data;

  // Verify bills exist and are pending
  const { rows: bills } = await knex.raw(
    `SELECT id, wire_transfer_id, sort_order FROM china_finance_bill WHERE id = ANY(?)`,
    [bill_ids]
  ) as { rows: Array<{ id: string; wire_transfer_id: string | null; sort_order: number }> };

  if (bills.length !== bill_ids.length) {
    return res.status(400).json({ message: "One or more bill IDs not found" });
  }
  const alreadyAssigned = bills.filter((b) => b.wire_transfer_id !== null);
  if (alreadyAssigned.length > 0) {
    return res.status(400).json({
      message: "One or more bills are already assigned to a wire transfer",
      ids: alreadyAssigned.map((b) => b.id),
    });
  }

  // Create wire transfer
  const wireId = randomUUID();
  await knex.raw(
    `INSERT INTO china_wire_transfer
       (id, status, sent_date, wire_amount_cents, notes)
     VALUES (?, 'sent', ?, ?, ?)`,
    [wireId, sent_date, wire_amount_cents, notes ?? null]
  );

  // If bank fee from previous wire → create a bank_fee bill row
  // It sits at sort_order = min(selected) - 1, dated from the previous wire
  if (bank_fee_from_previous_cents && bank_fee_from_previous_cents > 0) {
    const { rows: prevWire } = await knex.raw(
      `SELECT sent_date FROM china_wire_transfer
       WHERE id != ? ORDER BY sent_date DESC NULLS LAST LIMIT 1`,
      [wireId]
    ) as { rows: [{ sent_date: string | null }] };

    const feeDate = prevWire[0]?.sent_date ?? sent_date;
    const minSort = Math.min(...bills.map((b) => b.sort_order));
    const feeBillId = randomUUID();

    await knex.raw(
      `INSERT INTO china_finance_bill
         (id, type, sort_order, wire_transfer_id, document_type,
          payee, description, amount_cents, document_date)
       VALUES (?, 'bank_fee', ?, ?, 'bank_fee',
               'Bank Fee', 'Wire transfer bank fee (previous wire)', ?, ?)`,
      [feeBillId, minSort - 0.5, wireId, bank_fee_from_previous_cents, feeDate]
    );
  }

  // Assign selected bills to this wire
  await knex.raw(
    `UPDATE china_finance_bill
       SET wire_transfer_id = ?, updated_at = now()
     WHERE id = ANY(?)`,
    [wireId, bill_ids]
  );

  const { rows: created } = await knex.raw(
    `SELECT cwt.*,
       (SELECT COUNT(*) FROM china_finance_bill WHERE wire_transfer_id = cwt.id)::int AS bill_count
     FROM china_wire_transfer cwt WHERE cwt.id = ?`,
    [wireId]
  ) as { rows: [Record<string, unknown>] };

  return res.status(201).json({ wire_transfer: created[0] });
};
