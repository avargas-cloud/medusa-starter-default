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
import { randomUUID } from "crypto";
import { z } from "zod";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const updateWireSchema = z.object({
  sent_date: z.string().date().optional(),
  wire_amount_cents: z.number().int().min(1).optional(),
  notes: z.string().max(1000).optional(),
  bank_fee_included_cents: z.number().int().min(0).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

// Reconcile the synthetic bank_fee bill row attached to a wire.
// - When the target is 0: drop the bill and its application.
// - When > 0 and the row exists: UPDATE the amount and the application's applied_cents.
// - When > 0 and the row is missing: INSERT a new bill + application pair.
async function reconcileWireBankFee(
  knex: Knex,
  wireId: string,
  targetCents: number,
  sentDate: string | null
): Promise<void> {
  const { rows: existing } = await knex.raw(
    `SELECT id, sort_order FROM china_finance_bill
       WHERE wire_transfer_id = ? AND document_type = 'bank_fee'
       ORDER BY sort_order ASC
       LIMIT 1`,
    [wireId]
  ) as { rows: Array<{ id: string; sort_order: number }> };
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
       SELECT cwta.bill_id, SUM(cwta.applied_cents)::integer AS paid_cents
       FROM china_wire_transfer_application cwta
       JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
       WHERE cwt.status = 'confirmed'
       GROUP BY cwta.bill_id
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
  const { sent_date, wire_amount_cents, notes, bank_fee_included_cents } = parsed.data;
  const editsProtected =
    wire_amount_cents !== undefined || bank_fee_included_cents !== undefined || sent_date !== undefined;

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;

  try {
    // Lock the wire row so the confirmed-check and the update are atomic against
    // a concurrent confirm. A confirmed wire is a settled bank transaction: its
    // money/date fields are immutable (only notes may change once confirmed).
    const { rows: statusRows } = await db.raw(
      `SELECT status FROM china_wire_transfer WHERE id = ? FOR UPDATE`, [id]
    ) as { rows: Array<{ status: string }> };
    if (statusRows.length === 0) {
      if (trx) await trx.rollback();
      return res.status(404).json({ message: "Wire transfer not found" });
    }
    if (statusRows[0]!.status === "confirmed" && editsProtected) {
      if (trx) await trx.rollback();
      return res.status(409).json({ message: "Cannot edit amount/fee/date of a confirmed wire transfer" });
    }

    const setClauses: string[] = ["updated_at = now()"];
    const bindings: unknown[] = [];
    if (sent_date !== undefined) { setClauses.push("sent_date = ?"); bindings.push(sent_date); }
    if (wire_amount_cents !== undefined) { setClauses.push("wire_amount_cents = ?"); bindings.push(wire_amount_cents); }
    if (notes !== undefined) { setClauses.push("notes = ?"); bindings.push(notes); }
    bindings.push(id);

    const { rows } = await db.raw(
      `UPDATE china_wire_transfer SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
      bindings
    ) as { rows: Array<Record<string, unknown>> };

    if (bank_fee_included_cents !== undefined && id) {
      const wireRow = rows[0] as { sent_date: string | null };
      await reconcileWireBankFee(db, id, bank_fee_included_cents, wireRow.sent_date);
    }

    if (trx) await trx.commit();
    return res.json({ wire_transfer: rows[0] });
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }
};

export const DELETE = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { id } = req.params;

  // PIN de supervisor. La pantalla de China Finance ya abría un modal antes de
  // borrar ("Enter supervisor PIN to delete this wire transfer and return its
  // bills to pending"), pero el gate vivía SOLO ahí y la comparación ocurría en
  // el navegador: un DELETE directo a esta ruta borraba el wire y devolvía sus
  // bills a pendiente sin encontrar ninguna puerta.
  //
  // Acá es incondicional — no hay caso en que borrar un wire transfer sea una
  // operación de rutina.
  {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: knex as unknown as PinConn,
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard);
      return res.status(status).json(body);
    }
  }

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
