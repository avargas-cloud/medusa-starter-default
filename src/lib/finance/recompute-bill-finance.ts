/**
 * recompute-bill-finance.ts
 *
 * Keeps the China-Finance projection of a vendor bill consistent after the
 * bill's product lines change (qty edit — Phase 2, or "Update From…" — Phase 3).
 *
 * A regular/service/freight Veetech vendor bill is mirrored into
 * `china_finance_bill` (cfb) by syncVeetchBills. Wires pay bills through
 * `china_wire_transfer_application` (cwta) rows that GREEDILY allocate
 * `min(remaining, balance)` — so a wire's `wire_amount_cents` is the real money
 * sent and may legitimately exceed SUM(applied_cents) (intentional surplus /
 * over-funding). NEVER collapse a wire total to SUM(apps).
 *
 * When a draft bill's amount changes we must, transactionally and with row
 * locks (the CALLER owns the transaction — pass a trx as `db`):
 *
 *   1. Recompute cfb.amount_cents = SUM(unit_cost_cents × qty) over the bill's
 *      non-deleted lines (matches syncVeetchBills' own sum).
 *   2. For each application on a SCHEDULED (draft) wire only:
 *        - FULL app (applied == old balance) → set applied to the NEW balance.
 *        - PARTIAL app (applied < old balance):
 *            · new balance ≥ applied  → preserve (valid on increase or mild decrease);
 *            · new balance < applied   → CONFLICT (return, do not corrupt).
 *      The wire total is adjusted DELTA-aware (wire += Δapplied) so any
 *      pre-existing surplus is preserved exactly.
 *   3. Confirmed-wire applications (real money) are never touched.
 *
 * Money is integer cents throughout.
 */

export type RecomputeKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export type RecomputeConflict = {
  cfb_id: string;
  application_id: string;
  wire_transfer_id: string;
  applied_cents: number;
  new_balance_cents: number;
};

export type RecomputeResult =
  | {
      ok: true;
      cfb_updated: number;
      apps_adjusted: number;
      wires_adjusted: number;
      old_amount_cents: number | null;
      new_amount_cents: number | null;
    }
  | {
      ok: false;
      code: "scheduled_partial_app_conflict";
      message: string;
      conflicts: RecomputeConflict[];
    };

type CfbRow = { id: string; amount_cents: number };
type DraftAppRow = {
  id: string;
  applied_cents: number;
  wire_transfer_id: string;
};

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Recompute the china-finance projection for a vendor bill. MUST be called
 * inside the caller's transaction (`db` should be a trx) so the FOR UPDATE
 * locks hold and the whole edit is atomic. Returns ok:false on a partial-app
 * conflict WITHOUT mutating finance rows beyond what is safe — the caller
 * should roll back its transaction.
 */
export async function recomputeBillFinanceLinks(
  db: RecomputeKnex,
  vendorBillId: string
): Promise<RecomputeResult> {
  // 1. Lock the bill's china_finance_bill row(s). Typically exactly one.
  const { rows: cfbRows } = (await db.raw(
    `SELECT id, amount_cents
       FROM china_finance_bill
      WHERE vendor_bill_id = ? AND type = 'vendor_bill'
      FOR UPDATE`,
    [vendorBillId]
  )) as { rows: CfbRow[] };

  if (cfbRows.length === 0) {
    // Bill not mirrored into china finance (e.g. not a Veetech bill, or not yet
    // synced). Nothing to reconcile.
    return {
      ok: true,
      cfb_updated: 0,
      apps_adjusted: 0,
      wires_adjusted: 0,
      old_amount_cents: null,
      new_amount_cents: null,
    };
  }

  // 2. New amount from the bill's current (already-persisted) lines — same sum
  //    syncVeetchBills uses (all non-deleted lines, no line_type filter).
  const { rows: sumRows } = (await db.raw(
    `SELECT COALESCE(SUM(unit_cost_cents::bigint * qty), 0)::integer AS amount
       FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
    [vendorBillId]
  )) as { rows: Array<{ amount: number }> };
  const newAmount = toInt(sumRows[0]?.amount ?? 0);

  const conflicts: RecomputeConflict[] = [];
  let appsAdjusted = 0;
  const wiresAdjusted = new Set<string>();
  let firstOld: number | null = null;

  for (const cfb of cfbRows) {
    const oldAmount = toInt(cfb.amount_cents);
    if (firstOld === null) firstOld = oldAmount;

    // Confirmed money already applied to this cfb (immutable).
    const { rows: paidRows } = (await db.raw(
      `SELECT COALESCE(SUM(cwta.applied_cents), 0)::integer AS paid
         FROM china_wire_transfer_application cwta
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cwta.bill_id = ? AND cwt.status = 'confirmed'`,
      [cfb.id]
    )) as { rows: Array<{ paid: number }> };
    const confirmedPaid = toInt(paidRows[0]?.paid ?? 0);

    const oldBalance = Math.max(oldAmount - confirmedPaid, 0);
    const newBalance = Math.max(newAmount - confirmedPaid, 0);

    // Draft (scheduled) applications on this cfb — lock both app + wire rows.
    const { rows: draftApps } = (await db.raw(
      `SELECT cwta.id, cwta.applied_cents, cwta.wire_transfer_id
         FROM china_wire_transfer_application cwta
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cwta.bill_id = ? AND cwt.status = 'draft'
        FOR UPDATE`,
      [cfb.id]
    )) as { rows: DraftAppRow[] };

    for (const app of draftApps) {
      const applied = toInt(app.applied_cents);
      let newApplied: number;

      if (applied === oldBalance) {
        // Full app — follow the balance.
        newApplied = newBalance;
      } else if (newBalance >= applied) {
        // Partial app still valid (increase, or decrease that stays ≥ applied).
        newApplied = applied;
      } else {
        // Decrease drops the bill below this partial allocation — refuse.
        conflicts.push({
          cfb_id: cfb.id,
          application_id: app.id,
          wire_transfer_id: app.wire_transfer_id,
          applied_cents: applied,
          new_balance_cents: newBalance,
        });
        continue;
      }

      const delta = newApplied - applied;
      if (delta === 0) continue;

      if (newApplied <= 0) {
        // Allocation fully drained — remove the row, shrink the wire by the
        // amount it was covering.
        await db.raw(`DELETE FROM china_wire_transfer_application WHERE id = ?`, [
          app.id,
        ]);
      } else {
        await db.raw(
          `UPDATE china_wire_transfer_application
              SET applied_cents = ?, updated_at = now()
            WHERE id = ?`,
          [newApplied, app.id]
        );
      }

      // Delta-aware wire total: preserve surplus, never recompute as SUM(apps).
      await db.raw(
        `UPDATE china_wire_transfer
            SET wire_amount_cents = GREATEST(wire_amount_cents + ?, 0),
                updated_at = now()
          WHERE id = ?`,
        [delta, app.wire_transfer_id]
      );

      appsAdjusted += 1;
      wiresAdjusted.add(app.wire_transfer_id);
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      code: "scheduled_partial_app_conflict",
      message:
        "This change would drop the bill below a scheduled wire's partial " +
        "allocation. Adjust or unlink that scheduled wire first.",
      conflicts,
    };
  }

  // 3. Persist the new cfb amount(s).
  await db.raw(
    `UPDATE china_finance_bill
        SET amount_cents = ?, updated_at = now()
      WHERE vendor_bill_id = ? AND type = 'vendor_bill'`,
    [newAmount, vendorBillId]
  );

  return {
    ok: true,
    cfb_updated: cfbRows.length,
    apps_adjusted: appsAdjusted,
    wires_adjusted: wiresAdjusted.size,
    old_amount_cents: firstOld,
    new_amount_cents: newAmount,
  };
}
