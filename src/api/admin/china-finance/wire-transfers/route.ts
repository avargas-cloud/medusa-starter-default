/**
 * GET  /admin/china-finance/wire-transfers
 *   Lists all wire transfers ordered by sent_date DESC.
 *
 * POST /admin/china-finance/wire-transfers
 *   Creates a new wire transfer.
 *   Assigns selected bills to the wire.
 *   If bank_fee_from_previous_cents is provided, creates a bank_fee bill row
 *   dated from this wire and covered by the same wire.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }>;
};

const createWireSchema = z.object({
  bill_ids: z.array(z.string()),
  wire_amount_cents: z.number().int().min(1),
  sent_date: z.string().date(),
  include_opening_balance: z.boolean().optional(),
  bank_fee_from_previous_cents: z.number().int().min(0).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["draft", "confirmed"]).optional(),
  // "exact" (split-bill model): allocate ONLY to the selected bills, each at its
  // own balance — never greedily pull in other pending bills to fill the wire.
  // Defaults to "greedy" for backward compatibility with older callers.
  allocation_mode: z.enum(["greedy", "exact"]).optional(),
});

type BillAllocationCandidate = {
  id: string;
  sort_order: number;
  amount_cents: number;
  paid_cents: number;
  bill_balance_cents: number;
};

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
      COUNT(cwta.id)::int                 AS bill_count,
      COALESCE(SUM(cwta.applied_cents), 0)::bigint AS covered_amount_cents
    FROM china_wire_transfer cwt
    LEFT JOIN china_wire_transfer_application cwta ON cwta.wire_transfer_id = cwt.id
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
    include_opening_balance,
    bank_fee_from_previous_cents,
    notes,
    status: wireStatusInput,
    allocation_mode,
  } = parsed.data;
  const wireStatus = wireStatusInput ?? "confirmed";
  const exactAllocation = allocation_mode === "exact";
  const isDraft = wireStatus === "draft";

  if (bill_ids.length === 0 && !include_opening_balance) {
    return res.status(400).json({ message: "Select at least one bill" });
  }
  if ((bank_fee_from_previous_cents ?? 0) > wire_amount_cents) {
    return res.status(400).json({ message: "Wire amount must cover the bank fee" });
  }

  // Verify bills exist and still have an open balance.
  // Only confirmed wires consume bill balance — drafts are reservations only.
  const { rows: bills } = bill_ids.length > 0
    ? await knex.raw(
      `WITH paid AS (
         SELECT cwta.bill_id, SUM(cwta.applied_cents)::integer AS paid_cents
         FROM china_wire_transfer_application cwta
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
         WHERE cwt.status = 'confirmed'
         GROUP BY cwta.bill_id
       )
       SELECT
         cfb.id,
         cfb.sort_order,
         cfb.amount_cents,
         COALESCE(paid.paid_cents, 0) AS paid_cents,
         GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents
       FROM china_finance_bill cfb
       LEFT JOIN paid ON paid.bill_id = cfb.id
       WHERE cfb.id = ANY(?)`,
      [bill_ids]
    ) as { rows: BillAllocationCandidate[] }
    : { rows: [] as BillAllocationCandidate[] };

  if (bills.length !== bill_ids.length) {
    return res.status(400).json({ message: "One or more bill IDs not found" });
  }
  const paidOff = bills.filter((b) => Number(b.bill_balance_cents) <= 0);
  if (paidOff.length > 0) {
    return res.status(400).json({
      message: "One or more bills are already fully paid",
      ids: paidOff.map((b) => b.id),
    });
  }

  let openingBalanceCents = 0;
  if (include_opening_balance) {
    const [{ rows: existingWires }, { rows: existingOpening }, { rows: settingsRows }] = await Promise.all([
      knex.raw(`SELECT id FROM china_wire_transfer LIMIT 1`) as Promise<{ rows: Array<{ id: string }> }>,
      knex.raw(`SELECT id FROM china_finance_bill WHERE document_type = 'opening_balance' LIMIT 1`) as Promise<{ rows: Array<{ id: string }> }>,
      knex.raw(`SELECT opening_balance_cents FROM china_finance_settings LIMIT 1`) as Promise<{ rows: Array<{ opening_balance_cents: number }> }>,
    ]);

    if (existingWires.length > 0 || existingOpening.length > 0) {
      return res.status(400).json({ message: "Opening balance can only be included on the first wire transfer" });
    }

    openingBalanceCents = Number(settingsRows[0]?.opening_balance_cents ?? 0);
    if (openingBalanceCents <= 0) {
      return res.status(400).json({ message: "No opening balance is configured" });
    }
  }

  // Exact allocation must fund its selected bills EXACTLY — no leftover (wire >
  // Σ bills → unassigned money) and no shortfall (wire < a bill's balance →
  // applied < amount, the partial-draft state the delta engine rejects). To
  // schedule a partial, split the bill instead of under-funding the wire.
  if (exactAllocation) {
    const selectedBalance = bills.reduce((s, b) => s + Number(b.bill_balance_cents), 0);
    const required = selectedBalance + openingBalanceCents + (bank_fee_from_previous_cents ?? 0);
    if (wire_amount_cents !== required) {
      return res.status(400).json({
        message: "Exact allocation requires wire_amount_cents to equal Σ(selected bill balances) + opening + bank fee",
        expected: required,
        got: wire_amount_cents,
      });
    }
  }

  // Create wire transfer
  const wireId = randomUUID();
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    await db.raw(
      `INSERT INTO china_wire_transfer
         (id, status, sent_date, wire_amount_cents, received_amount_cents, confirmed_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        wireId,
        wireStatus,
        sent_date,
        wire_amount_cents,
        isDraft ? null : wire_amount_cents,
        isDraft ? null : sent_date,
        notes ?? null,
      ]
    );

    let applicationSort = 1;
    let remainingForBills = wire_amount_cents - (bank_fee_from_previous_cents ?? 0);

    if (include_opening_balance && openingBalanceCents > 0) {
      const { rows: settingsRows } = await db.raw(
        `SELECT opening_balance_date FROM china_finance_settings LIMIT 1`
      ) as { rows: Array<{ opening_balance_date: string | null }> };
      const openingBillId = randomUUID();

      await db.raw(
        `INSERT INTO china_finance_bill
           (id, type, sort_order, wire_transfer_id, document_type,
            invoice_number, payee, description, amount_cents, document_date)
         VALUES (?, 'opening_balance', ?, ?, 'opening_balance',
                 'Cut Point', 'Opening Balance', 'Opening balance from cut point', ?, ?)`,
        [
          openingBillId,
          bills.length > 0 ? Math.min(...bills.map((b) => b.sort_order)) - 1 : 0,
          wireId,
          openingBalanceCents,
          settingsRows[0]?.opening_balance_date ?? sent_date,
        ]
      );

      const applied = Math.min(remainingForBills, openingBalanceCents);
      if (applied > 0) {
        await db.raw(
          `INSERT INTO china_wire_transfer_application
             (id, wire_transfer_id, bill_id, applied_cents, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
          [randomUUID(), wireId, openingBillId, applied, applicationSort++]
        );
        remainingForBills -= applied;
      }
    }

    // Bank fee is paid by this same wire, so it is assigned to this wire and
    // appears as a covered ledger line immediately above the wire row.
    if (bank_fee_from_previous_cents && bank_fee_from_previous_cents > 0) {
      const maxSort = bills.length > 0 ? Math.max(...bills.map((b) => b.sort_order)) : 1;
      const feeBillId = randomUUID();
      const feeDescription = `Wire transfer bank fee from wire ${wireId}`;

      await db.raw(
        `INSERT INTO china_finance_bill
           (id, type, sort_order, wire_transfer_id, document_type,
            payee, description, amount_cents, document_date)
         VALUES (?, 'bank_fee', ?, ?, 'bank_fee',
                 'Bank Fee', ?, ?, ?)`,
        [feeBillId, maxSort + 1, wireId, feeDescription, bank_fee_from_previous_cents, sent_date]
      );
      await db.raw(
        `INSERT INTO china_wire_transfer_application
           (id, wire_transfer_id, bill_id, applied_cents, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), wireId, feeBillId, bank_fee_from_previous_cents, applicationSort++]
      );
    }

    const selectedIds = new Set(bill_ids);
    const selectedBills = [...bills].sort((a, b) => a.sort_order - b.sort_order);
    // "exact" mode allocates ONLY to the selected bills (split-bill model, where
    // each partial is a discrete schedulable unit). Greedy mode additionally
    // fills any leftover wire amount with other pending bills.
    const extraBills = exactAllocation
      ? ([] as BillAllocationCandidate[])
      : ((await db.raw(
          `WITH paid AS (
             SELECT cwta.bill_id, SUM(cwta.applied_cents)::integer AS paid_cents
             FROM china_wire_transfer_application cwta
             JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
             WHERE cwt.status = 'confirmed'
             GROUP BY cwta.bill_id
           )
           SELECT
             cfb.id,
             cfb.sort_order,
             cfb.amount_cents,
             COALESCE(paid.paid_cents, 0) AS paid_cents,
             GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents
           FROM china_finance_bill cfb
           LEFT JOIN paid ON paid.bill_id = cfb.id
           WHERE GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) > 0
           ORDER BY cfb.sort_order ASC`
        )) as { rows: BillAllocationCandidate[] }).rows;

    const candidates = [
      ...selectedBills,
      ...extraBills.filter((bill) => !selectedIds.has(bill.id)),
    ];

    const fullyPaidIds: string[] = [];
    for (const bill of candidates) {
      if (remainingForBills <= 0) break;
      const balance = Number(bill.bill_balance_cents);
      if (balance <= 0) continue;
      const applied = Math.min(remainingForBills, balance);
      await db.raw(
        `INSERT INTO china_wire_transfer_application
           (id, wire_transfer_id, bill_id, applied_cents, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), wireId, bill.id, applied, applicationSort++]
      );
      remainingForBills -= applied;
      if (applied === balance) fullyPaidIds.push(bill.id);
    }

    if (fullyPaidIds.length > 0) {
      await db.raw(
        `UPDATE china_finance_bill
         SET wire_transfer_id = ?, updated_at = now()
         WHERE id = ANY(?)`,
        [wireId, fullyPaidIds]
      );
    }

    const { rows: created } = await db.raw(
      `SELECT cwt.*,
         (SELECT COUNT(*) FROM china_wire_transfer_application WHERE wire_transfer_id = cwt.id)::int AS bill_count
       FROM china_wire_transfer cwt WHERE cwt.id = ?`,
      [wireId]
    ) as { rows: [Record<string, unknown>] };

    if (trx) await trx.commit();
    return res.status(201).json({ wire_transfer: created[0] });
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }
};
