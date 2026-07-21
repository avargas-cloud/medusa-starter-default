/**
 * POST /admin/china-finance/wire-transfers/:id/credits
 *   Applies an overpay CREDIT to a DRAFT (scheduled) wire. The wire's cash to
 *   send drops by the same amount — the credit is "used" instead of new money.
 *
 * DELETE /admin/china-finance/wire-transfers/:id/credits?credit_id=…
 *   Removes a credit line from a DRAFT wire and restores its cash amount.
 *
 * Money rules (Codex-reviewed):
 *   - available(source bill) = MAX(0, Σ applied on CONFIRMED wires − amount)
 *                              − Σ already consumed (draft AND confirmed wires,
 *                                so two drafts can never spend the same credit).
 *   - Confirmed wires are immutable: no credit can be added or removed there.
 *   - The consumption row snapshots the source state + a human note at apply
 *     time, so the explanation sent to the agent never mutates retroactively.
 *   - Concurrency: an advisory xact lock on the source bill serialises two
 *     simultaneous applies of the same credit.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../../purchase-orders/_lib/auth";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const applySchema = z.object({
  source_bill_id: z.string().min(1),
  // Omitted → apply the full available credit.
  amount_cents: z.number().int().positive().optional(),
});

const money = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;

function resolveKnex(req: AuthenticatedMedusaRequest): Knex {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as Knex;
}

async function loadCreditState(
  db: Knex,
  sourceBillId: string
): Promise<{
  amount_cents: number;
  confirmed_applied: number;
  consumed: number;
  vendor_bill_number: string | null;
  invoice_number: string | null;
  origin_sent_date: string | null;
} | null> {
  const { rows } = await db.raw(
    `SELECT b.amount_cents,
            b.invoice_number,
            vb.number AS vendor_bill_number,
            COALESCE((SELECT SUM(a.applied_cents)::bigint
                        FROM china_wire_transfer_application a
                        JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
                       WHERE a.bill_id = b.id AND w.status = 'confirmed'), 0) AS confirmed_applied,
            COALESCE((SELECT SUM(c.amount_cents)::bigint
                        FROM china_finance_wire_credit c
                       WHERE c.source_bill_id = b.id), 0) AS consumed,
            (SELECT w.sent_date::text
               FROM china_wire_transfer_application a
               JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
              WHERE a.bill_id = b.id AND w.status = 'confirmed'
              ORDER BY w.sent_date DESC NULLS LAST LIMIT 1) AS origin_sent_date
       FROM china_finance_bill b
       LEFT JOIN vendor_bill vb ON vb.id = b.vendor_bill_id
      WHERE b.id = ?`,
    [sourceBillId]
  );
  const r = rows[0] as
    | {
        amount_cents: number | string;
        confirmed_applied: number | string;
        consumed: number | string;
        vendor_bill_number: string | null;
        invoice_number: string | null;
        origin_sent_date: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    amount_cents: Number(r.amount_cents),
    confirmed_applied: Number(r.confirmed_applied),
    consumed: Number(r.consumed),
    vendor_bill_number: r.vendor_bill_number,
    invoice_number: r.invoice_number,
    origin_sent_date: r.origin_sent_date,
  };
}

export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  let actorUserId: string | null = null;
  try {
    actorUserId = getActorUserId(req) ?? null;
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id: wireId } = req.params as { id: string };
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }
  const { source_bill_id } = parsed.data;

  const knex = resolveKnex(req);
  if (!knex.transaction) {
    return res.status(500).json({ error: "Transactions unavailable" });
  }
  const trx = await knex.transaction();
  try {
    // Serialise concurrent consumption of the same source credit.
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext('cf_credit:' || ?))`, [
      source_bill_id,
    ]);

    const wireRows = await trx.raw(
      `SELECT id, status, wire_amount_cents FROM china_wire_transfer WHERE id = ? FOR UPDATE`,
      [wireId]
    );
    const wire = wireRows.rows[0] as
      | { id: string; status: string; wire_amount_cents: number }
      | undefined;
    if (!wire) {
      await trx.rollback();
      return res.status(404).json({ error: "Wire transfer not found" });
    }
    if (wire.status !== "draft") {
      await trx.rollback();
      return res.status(409).json({
        error: "Credits can only be applied to a scheduled (draft) wire — confirmed wires are immutable.",
        code: "wire_not_draft",
      });
    }

    const state = await loadCreditState(trx, source_bill_id);
    if (!state) {
      await trx.rollback();
      return res.status(404).json({ error: "Source bill not found" });
    }
    const generated = Math.max(0, state.confirmed_applied - state.amount_cents);
    const available = generated - state.consumed;
    if (available <= 0) {
      await trx.rollback();
      return res.status(409).json({
        error: "This bill has no available credit left.",
        code: "no_credit_available",
      });
    }
    const amount = parsed.data.amount_cents ?? available;
    if (amount > available) {
      await trx.rollback();
      return res.status(409).json({
        error: `Only ${money(available)} of credit is available on this bill.`,
        code: "credit_exceeds_available",
        available_cents: available,
      });
    }
    if (amount > wire.wire_amount_cents) {
      await trx.rollback();
      return res.status(409).json({
        error: `The credit (${money(amount)}) exceeds this wire's amount (${money(wire.wire_amount_cents)}).`,
        code: "credit_exceeds_wire",
      });
    }

    // The transparency note the buyer screenshots to the agent — frozen here.
    const origin = state.origin_sent_date
      ? ` paid by the wire of ${state.origin_sent_date}`
      : "";
    const doc = [state.vendor_bill_number, state.invoice_number]
      .filter(Boolean)
      .join(" · ");
    const note =
      `Credit from overpayment on ${doc || "a settled bill"}${origin}: ` +
      `paid ${money(state.confirmed_applied)}, bill adjusted to ${money(state.amount_cents)} ` +
      `(+${money(generated)} in our favour). Applying ${money(amount)} to this wire — cash to send is reduced by the same amount.`;

    const creditId = randomUUID();
    await trx.raw(
      `INSERT INTO china_finance_wire_credit
         (id, wire_transfer_id, source_bill_id, amount_cents, note,
          source_bill_amount_cents_at_apply, source_applied_cents_at_apply,
          source_wire_sent_date_at_apply, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        creditId,
        wireId,
        source_bill_id,
        amount,
        note,
        state.amount_cents,
        state.confirmed_applied,
        state.origin_sent_date,
        actorUserId,
      ]
    );
    // The credit replaces cash: the scheduled wire now sends less money.
    await trx.raw(
      `UPDATE china_wire_transfer
          SET wire_amount_cents = wire_amount_cents - ?, updated_at = now()
        WHERE id = ?`,
      [amount, wireId]
    );

    await trx.commit();
    return res.status(201).json({
      credit: { id: creditId, wire_transfer_id: wireId, source_bill_id, amount_cents: amount, note },
    });
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};

export const DELETE = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id: wireId } = req.params as { id: string };
  const creditId = (req.query as { credit_id?: string }).credit_id;
  if (!creditId) {
    return res.status(400).json({ error: "credit_id is required" });
  }

  const knex = resolveKnex(req);
  if (!knex.transaction) {
    return res.status(500).json({ error: "Transactions unavailable" });
  }
  const trx = await knex.transaction();
  try {
    const wireRows = await trx.raw(
      `SELECT id, status FROM china_wire_transfer WHERE id = ? FOR UPDATE`,
      [wireId]
    );
    const wire = wireRows.rows[0] as { id: string; status: string } | undefined;
    if (!wire) {
      await trx.rollback();
      return res.status(404).json({ error: "Wire transfer not found" });
    }
    if (wire.status !== "draft") {
      await trx.rollback();
      return res.status(409).json({
        error: "Credits on a confirmed wire are part of the settled payment and cannot be removed.",
        code: "wire_not_draft",
      });
    }

    const del = await trx.raw(
      `DELETE FROM china_finance_wire_credit
        WHERE id = ? AND wire_transfer_id = ?
        RETURNING amount_cents`,
      [creditId, wireId]
    );
    const removed = del.rows[0] as { amount_cents: number } | undefined;
    if (!removed) {
      await trx.rollback();
      return res.status(404).json({ error: "Credit line not found on this wire" });
    }
    // Restore the cash the credit was replacing.
    await trx.raw(
      `UPDATE china_wire_transfer
          SET wire_amount_cents = wire_amount_cents + ?, updated_at = now()
        WHERE id = ?`,
      [removed.amount_cents, wireId]
    );

    await trx.commit();
    return res.json({ removed: true, restored_cents: removed.amount_cents });
  } catch (err) {
    await trx.rollback();
    throw err;
  }
};
