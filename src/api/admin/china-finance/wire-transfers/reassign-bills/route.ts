/**
 * PATCH /admin/china-finance/wire-transfers/reassign-bills
 *
 * Batch reassignment of bills across DRAFT wire transfers (or to/from the
 * unassigned pool). Used by the Manage Wire Transfer modal in store-pos.
 *
 * Body:
 *   base_snapshot — what the client saw when the modal opened. Each entry
 *     is { bill_id, draft_wire_id | null }. Used for optimistic locking:
 *     if the current state differs we return 409 with the conflicting rows.
 *
 *   assignments — desired final state for each bill in scope.
 *     { bill_id, wire_transfer_id | null, applied_cents, sort_order }
 *
 * Rules:
 *   - Bills of type 'bank_fee' cannot be moved (they belong to their wire).
 *   - Confirmed wires are immutable — neither origin nor destination can be
 *     confirmed.
 *   - applied_cents must be in (0, max(amount_cents − Σ CONFIRMED applied, 0)]
 *     — a bill paid short is scheduled for its REMAINDER, not its full value.
 *   - A bill may have at most one DRAFT application after the patch.
 *   - Confirmed-wire applications for the same bill are preserved untouched.
 *
 * NOTE: bank_fee_included_cents and wire-level edits (sent_date,
 * wire_amount_cents) live in PATCH /wire-transfers/:id — the modal calls
 * those first, then this endpoint.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";
import { schedulableCents } from "../../../../../lib/china-finance/schedulable-amount";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const snapshotEntrySchema = z.object({
  bill_id: z.string(),
  draft_wire_id: z.string().nullable(),
});

const assignmentSchema = z.object({
  bill_id: z.string(),
  wire_transfer_id: z.string().nullable(),
  applied_cents: z.number().int().min(1),
  sort_order: z.number().int().min(0),
});

const bodySchema = z.object({
  base_snapshot: z.array(snapshotEntrySchema).max(2000),
  assignments: z.array(assignmentSchema).max(2000),
});

type BillRow = {
  id: string;
  type: string | null;
  amount_cents: number;
  wire_transfer_id: string | null;
};

type WireRow = {
  id: string;
  status: "draft" | "confirmed";
};

type DraftApplicationRow = {
  id: string;
  wire_transfer_id: string;
  bill_id: string;
  applied_cents: number;
};

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { base_snapshot, assignments } = parsed.data;

  const billIds = Array.from(
    new Set([
      ...base_snapshot.map((s) => s.bill_id),
      ...assignments.map((a) => a.bill_id),
    ])
  );
  if (billIds.length === 0) {
    return res.json({ success: true, updated: 0 });
  }

  const wireIds = Array.from(
    new Set(
      [
        ...base_snapshot.map((s) => s.draft_wire_id),
        ...assignments.map((a) => a.wire_transfer_id),
      ].filter((v): v is string => Boolean(v))
    )
  );

  // Detect duplicate bill_id in assignments early.
  const seenAssignmentBills = new Set<string>();
  for (const a of assignments) {
    if (seenAssignmentBills.has(a.bill_id)) {
      return res.status(400).json({
        message: "Duplicate bill in assignments",
        bill_id: a.bill_id,
      });
    }
    seenAssignmentBills.add(a.bill_id);
  }

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;

  try {
    // Lock the bills and wires involved so concurrent reassign requests
    // serialize instead of racing.
    const { rows: bills } = (await db.raw(
      `SELECT id, type, amount_cents, wire_transfer_id
         FROM china_finance_bill
        WHERE id = ANY(?)
        FOR UPDATE`,
      [billIds]
    )) as { rows: BillRow[] };

    if (bills.length !== billIds.length) {
      const found = new Set(bills.map((b) => b.id));
      const missing = billIds.filter((id) => !found.has(id));
      if (trx) await trx.rollback();
      return res
        .status(400)
        .json({ message: "One or more bills not found", ids: missing });
    }

    const billsById = new Map(bills.map((b) => [b.id, b]));

    // Bank-fee bills are atomically owned by their wire — never movable.
    const bankFeeMovers = assignments.filter(
      (a) => billsById.get(a.bill_id)?.type === "bank_fee"
    );
    if (bankFeeMovers.length > 0) {
      if (trx) await trx.rollback();
      return res.status(400).json({
        message: "Bank fee bills cannot be reassigned",
        ids: bankFeeMovers.map((a) => a.bill_id),
      });
    }

    // What each bill still OWES, which is not the same as what it costs.
    //
    // A bill may already carry a confirmed application: the wire went out and
    // that money is gone. The ceiling for anything scheduled now is therefore
    // the remainder, never the bill's full amount — the old check compared
    // against `amount_cents` and would have let a bill paid short be scheduled
    // for its whole value a second time.
    //
    // Clamped at 0 on purpose. A bill corrected DOWNWARD after being paid has
    // confirmed applications LARGER than its amount (VB-1045 sits at $3,025.00
    // with $3,136.50 applied); it owes nothing, and its excess settles through
    // `china_finance_wire_credit`, not through another application here.
    const { rows: confirmedRows } = (await db.raw(
      `SELECT cwta.bill_id, COALESCE(SUM(cwta.applied_cents), 0)::int AS confirmed_cents
         FROM china_wire_transfer_application cwta
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cwta.bill_id = ANY(?)
          AND cwt.status = 'confirmed'
        GROUP BY cwta.bill_id`,
      [billIds]
    )) as { rows: Array<{ bill_id: string; confirmed_cents: number | string }> };
    const confirmedByBill = new Map(
      confirmedRows.map((r) => [r.bill_id, Number(r.confirmed_cents)])
    );

    for (const a of assignments) {
      const bill = billsById.get(a.bill_id)!;
      const confirmed = confirmedByBill.get(a.bill_id) ?? 0;
      const schedulable = schedulableCents(bill.amount_cents, confirmed);
      if (a.applied_cents > schedulable) {
        if (trx) await trx.rollback();
        return res.status(400).json({
          message:
            confirmed > 0
              ? "applied_cents exceeds what this bill still owes after its confirmed payments"
              : "applied_cents exceeds bill.amount_cents",
          bill_id: a.bill_id,
          amount_cents: bill.amount_cents,
          confirmed_cents: confirmed,
          schedulable_cents: schedulable,
        });
      }
    }

    let wires: WireRow[] = [];
    if (wireIds.length > 0) {
      const wiresResult = (await db.raw(
        `SELECT id, status
           FROM china_wire_transfer
          WHERE id = ANY(?)
          FOR UPDATE`,
        [wireIds]
      )) as { rows: WireRow[] };
      wires = wiresResult.rows;

      if (wires.length !== wireIds.length) {
        const found = new Set(wires.map((w) => w.id));
        const missing = wireIds.filter((id) => !found.has(id));
        if (trx) await trx.rollback();
        return res
          .status(400)
          .json({ message: "One or more wire transfers not found", ids: missing });
      }

      const confirmedWires = wires.filter((w) => w.status === "confirmed");
      if (confirmedWires.length > 0) {
        if (trx) await trx.rollback();
        return res.status(400).json({
          message: "Cannot reassign bills to/from confirmed wire transfers",
          ids: confirmedWires.map((w) => w.id),
        });
      }
    }

    // Fetch current DRAFT applications for the bills in scope.
    // Confirmed-wire applications are intentionally excluded — they stay put.
    const { rows: draftApps } = (await db.raw(
      `SELECT cwta.id, cwta.wire_transfer_id, cwta.bill_id, cwta.applied_cents
         FROM china_wire_transfer_application cwta
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cwta.bill_id = ANY(?)
          AND cwt.status = 'draft'`,
      [billIds]
    )) as { rows: DraftApplicationRow[] };

    const currentDraftByBill = new Map<string, DraftApplicationRow>();
    for (const app of draftApps) {
      // If a bill somehow appears in multiple draft wires, take the first —
      // the modal's mental model is 1 draft per bill.
      if (!currentDraftByBill.has(app.bill_id)) {
        currentDraftByBill.set(app.bill_id, app);
      }
    }

    // Optimistic-lock check: snapshot must match current draft assignment.
    const conflicts: Array<{
      bill_id: string;
      expected: string | null;
      actual: string | null;
    }> = [];
    for (const snap of base_snapshot) {
      const actual = currentDraftByBill.get(snap.bill_id)?.wire_transfer_id ?? null;
      if (actual !== snap.draft_wire_id) {
        conflicts.push({
          bill_id: snap.bill_id,
          expected: snap.draft_wire_id,
          actual,
        });
      }
    }
    if (conflicts.length > 0) {
      if (trx) await trx.rollback();
      return res
        .status(409)
        .json({ message: "Snapshot out of date", conflicts });
    }

    // Apply assignments: for each bill, drop its DRAFT application row(s)
    // and re-create one if a destination is specified.
    let updatedCount = 0;
    for (const a of assignments) {
      const current = currentDraftByBill.get(a.bill_id);

      if (current?.wire_transfer_id === a.wire_transfer_id) {
        // Same destination — just update applied_cents / sort_order in place.
        if (a.wire_transfer_id) {
          await db.raw(
            `UPDATE china_wire_transfer_application
                SET applied_cents = ?, sort_order = ?
              WHERE id = ?`,
            [a.applied_cents, a.sort_order, current.id]
          );
        }
        // bill.wire_transfer_id may need sync if destination changed truthiness.
        const billOwner = a.wire_transfer_id;
        const currentOwner = billsById.get(a.bill_id)!.wire_transfer_id;
        if (currentOwner !== billOwner) {
          await db.raw(
            `UPDATE china_finance_bill
                SET wire_transfer_id = ?, updated_at = now()
              WHERE id = ?`,
            [billOwner, a.bill_id]
          );
        }
        updatedCount += 1;
        continue;
      }

      // Different destination (or new): clear current draft app, then insert.
      if (current) {
        await db.raw(
          `DELETE FROM china_wire_transfer_application WHERE id = ?`,
          [current.id]
        );
      }

      if (a.wire_transfer_id) {
        await db.raw(
          `INSERT INTO china_wire_transfer_application
             (id, wire_transfer_id, bill_id, applied_cents, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            a.wire_transfer_id,
            a.bill_id,
            a.applied_cents,
            a.sort_order,
          ]
        );
      }

      await db.raw(
        `UPDATE china_finance_bill
            SET wire_transfer_id = ?, updated_at = now()
          WHERE id = ?`,
        [a.wire_transfer_id, a.bill_id]
      );
      updatedCount += 1;
    }

    if (trx) await trx.commit();
    return res.json({ success: true, updated: updatedCount });
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }
};
