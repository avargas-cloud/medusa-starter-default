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

import { materializePaidShortTranches } from "../china-finance/bill-split-payment";

// ─── gl-purchases-v2 §3 — bill balance (pg client, $1 bindings) ───
//
// Appended here (not a new file) per the plan: "extend
// lib/finance/recompute-bill-finance.ts ... with computeBillBalance". Uses a
// DIFFERENT client shape than the China-finance code above (`RecomputeKnex`,
// `?` bindings) — this half of the file talks to a raw `pg` client/pool with
// `$1` bindings, per gl-purchases-v2's convention (never mix the two styles
// in one query).

export type PgQueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export type BillPaidStatus = "open" | "partial" | "paid";

export interface BillBalance {
  vendor_bill_id: string;
  payable_cents: number;
  paid_cents: number;
  credited_cents: number;
  balance_cents: number;
  paid_status: BillPaidStatus;
}

function deriveStatus(payableCents: number, balanceCents: number): BillPaidStatus {
  if (payableCents <= 0) return balanceCents <= 0 ? "paid" : "open";
  if (balanceCents <= 0) return "paid";
  if (balanceCents < payableCents) return "partial";
  return "open";
}

interface PayableRow {
  id: string;
  status: string;
  qb_source: string | null;
  qb_amount_due_cents: number | string | null;
  line_total: number | string | null;
}

/**
 * `payable_cents` — plan §1: Σ `COALESCE(amount_cents, qty × unit_cost_cents)`
 * over every non-deleted line, EXCEPT the 66 `adopted` bills with no lines,
 * whose payable is `qb_amount_due_cents` (informative QB snapshot, since
 * there is nothing else to sum).
 */
async function loadPayableRows(
  client: PgQueryClient,
  billIds: string[]
): Promise<Map<string, PayableRow>> {
  const { rows } = (await client.query(
    `SELECT vb.id, vb.status, vb.qb_source, vb.qb_amount_due_cents,
            COUNT(vbl.id) AS line_count,
            COALESCE(SUM(COALESCE(vbl.amount_cents, vbl.qty * vbl.unit_cost_cents)), 0)::bigint AS line_total
       FROM vendor_bill vb
       LEFT JOIN vendor_bill_line vbl
         ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
      WHERE vb.id = ANY($1::text[]) AND vb.deleted_at IS NULL
      GROUP BY vb.id, vb.status, vb.qb_source, vb.qb_amount_due_cents`,
    [billIds]
  )) as { rows: (PayableRow & { line_count: number | string })[] };
  return new Map(rows.map((r) => [r.id, r]));
}

function toIntCents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Balance of a single bill: `balance_cents = payable − Σ active payment
 * allocations − Σ active credit applications` (plan §3). `qb_is_paid` never
 * participates — it is QB's own mirror, not a derivation input.
 */
export async function computeBillBalance(
  client: PgQueryClient,
  vendorBillId: string
): Promise<BillBalance | null> {
  const batch = await computeBillBalancesBatch(client, [vendorBillId]);
  return batch.get(vendorBillId) ?? null;
}

/** Batch variant — one round trip per table, used by the payables report. */
export async function computeBillBalancesBatch(
  client: PgQueryClient,
  billIds: string[]
): Promise<Map<string, BillBalance>> {
  const result = new Map<string, BillBalance>();
  if (billIds.length === 0) return result;

  const payableRows = await loadPayableRows(client, billIds);

  const { rows: paidRows } = (await client.query(
    `SELECT a.vendor_bill_id, COALESCE(SUM(a.amount_cents), 0)::bigint AS paid
       FROM vendor_bill_payment_allocation a
       JOIN vendor_bill_payment p ON p.id = a.payment_id
      WHERE a.vendor_bill_id = ANY($1::text[]) AND p.status = 'posted'
      GROUP BY a.vendor_bill_id`,
    [billIds]
  )) as { rows: Array<{ vendor_bill_id: string; paid: number | string }> };
  const paidByBill = new Map(paidRows.map((r) => [r.vendor_bill_id, toIntCents(r.paid)]));

  const { rows: creditRows } = (await client.query(
    `SELECT ca.vendor_bill_id, COALESCE(SUM(ca.amount_cents), 0)::bigint AS credited
       FROM vendor_credit_application ca
       JOIN vendor_credit vc ON vc.id = ca.credit_id
      WHERE ca.vendor_bill_id = ANY($1::text[]) AND ca.voided_at IS NULL AND vc.status = 'posted'
      GROUP BY ca.vendor_bill_id`,
    [billIds]
  )) as { rows: Array<{ vendor_bill_id: string; credited: number | string }> };
  const creditedByBill = new Map(
    creditRows.map((r) => [r.vendor_bill_id, toIntCents(r.credited)])
  );

  for (const id of billIds) {
    const row = payableRows.get(id) as
      | (PayableRow & { line_count: number | string })
      | undefined;
    if (!row) continue;
    // Plan §1: the 66 `adopted` (from QB) bills with zero lines carry
    // `qb_amount_due_cents` as their payable — there is nothing else to sum.
    // A bill with real lines (adopted or not) always sums those instead.
    const noLines = toIntCents(row.line_count) === 0;
    const payableCents =
      row.qb_source === "adopted" && noLines
        ? toIntCents(row.qb_amount_due_cents)
        : toIntCents(row.line_total);
    const paidCents = paidByBill.get(id) ?? 0;
    const creditedCents = creditedByBill.get(id) ?? 0;
    const balanceCents = payableCents - paidCents - creditedCents;
    result.set(id, {
      vendor_bill_id: id,
      payable_cents: payableCents,
      paid_cents: paidCents,
      credited_cents: creditedCents,
      balance_cents: balanceCents,
      paid_status: deriveStatus(payableCents, balanceCents),
    });
  }

  return result;
}

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
      code: "scheduled_partial_app_conflict" | "ambiguous_split_group";
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

  // 2b. The GROUP, not just the rows that carry `vendor_bill_id`.
  //
  // A split bill keeps `vendor_bill_id` on the ROOT only; its siblings hold NULL.
  // So a query keyed on `vendor_bill_id` sees one row and writing the whole bill
  // total onto it leaves the group summing total + siblings. Splitting VB-1053
  // into $3,763.37 + $11.78 would survive exactly until the next Save of that
  // bill, which restored the root to $3,775.15 and left the group claiming
  // $3,786.93 — more than the invoice, silently, and the operator schedules the
  // difference.
  //
  // The rule that cannot corrupt (and the ONLY one with operational meaning):
  //   · tranches holding CONFIRMED money keep their amount — that is history,
  //     and rewriting it changes retroactively which wire paid what;
  //   · the single OPEN tranche carries `max(T − Σ confirmed, 0)`.
  // Never proportional, never by `partial_seq`, never "add the delta to the root".
  //
  // An UNSPLIT bill is one member and this reduces to the previous behaviour
  // exactly — which is what keeps every non-China vendor bill Save unaffected.
  const rootId = cfbRows[0]!.id;
  const { rows: groupRows } = (await db.raw(
    `SELECT b.id, b.amount_cents, b.split_group_id,
            COALESCE(c.confirmed_cents, 0)::integer AS confirmed_cents
       FROM china_finance_bill b
       LEFT JOIN LATERAL (
         SELECT SUM(cwta.applied_cents)::integer AS confirmed_cents
           FROM china_wire_transfer_application cwta
           JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
          WHERE cwta.bill_id = b.id AND cwt.status = 'confirmed'
       ) c ON TRUE
      WHERE b.id = ?
         OR b.split_group_id = (SELECT COALESCE(split_group_id, id)
                                  FROM china_finance_bill WHERE id = ?)
      ORDER BY b.partial_seq NULLS FIRST, b.id
      FOR UPDATE OF b`,
    [rootId, rootId]
  )) as { rows: Array<{ id: string; amount_cents: number; confirmed_cents: number }> };

  const members = groupRows.length > 0 ? groupRows : cfbRows.map((r) => ({ ...r, confirmed_cents: 0 }));
  const groupConfirmed = members.reduce((n, m) => n + toInt(m.confirmed_cents), 0);

  // Target amount per member. `open` = no confirmed money on it.
  const openMembers = members.filter((m) => toInt(m.confirmed_cents) === 0);
  const targetById = new Map<string, number>();
  if (members.length === 1) {
    // Unsplit: the whole invoice lives on the one row. Unchanged behaviour.
    targetById.set(members[0]!.id, newAmount);
  } else if (openMembers.length === 1) {
    for (const m of members) targetById.set(m.id, toInt(m.amount_cents));
    targetById.set(openMembers[0]!.id, Math.max(newAmount - groupConfirmed, 0));
  } else {
    // Zero open tranches, or several. Splitting a change across an ambiguous set
    // is a decision, not arithmetic — so this refuses instead of guessing. The
    // operator resolves it by merging or by materialising the tranches
    // explicitly.
    return {
      ok: false,
      code: "ambiguous_split_group",
      message:
        `This bill is split into ${members.length} ledger records with ` +
        `${openMembers.length} of them unpaid, so there is no single record to ` +
        `absorb the change. Merge the partials first, then save.`,
      conflicts: [],
    };
  }

  const conflicts: RecomputeConflict[] = [];
  let appsAdjusted = 0;
  const wiresAdjusted = new Set<string>();
  let firstOld: number | null = null;

  for (const cfb of members) {
    const memberTarget = targetById.get(cfb.id) ?? newAmount;
    const oldAmount = toInt(cfb.amount_cents);
    if (cfb.id === rootId) firstOld = oldAmount;

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
    // Against THIS member's target, not the whole invoice: on a split group a
    // confirmed tranche keeps its own amount and only the open one moves.
    const newBalance = Math.max(memberTarget - confirmedPaid, 0);

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

  // 3. Persist per MEMBER. Keyed by id, never by `vendor_bill_id`: that column
  //    only exists on the root, so the old form could not reach a sibling even
  //    to leave it correct — it simply overwrote the root with the full total.
  let cfbUpdated = 0;
  for (const m of members) {
    const target = targetById.get(m.id);
    if (target === undefined || target === toInt(m.amount_cents)) continue;
    await db.raw(
      `UPDATE china_finance_bill SET amount_cents = ?, updated_at = now() WHERE id = ?`,
      [target, m.id]
    );
    cfbUpdated += 1;
  }

  // 4. A bill that was PAID and then edited UPWARD splits itself.
  //
  // This is the whole scenario, and it needs no button: the invoice was short,
  // the wire paid what the invoice said and confirmed, then the bill was
  // corrected to match the receipt and now owes the difference. The operator
  // should not have to ask for the two records — the moment the Save raises the
  // total above the money already sent, the ledger owes an explanation, so it
  // writes one.
  //
  // SCOPE — this only ever reaches Veetech (China agent) bills, and needs no
  // check to say so: `china_finance_bill` exists only for bills mirrored by
  // `syncVeetchBills`, so a local/USA vendor bill returns at the
  // `cfbRows.length === 0` guard far above and never gets here.
  //
  // Only ever from ONE record into two, and only when all three hold: the bill
  // is un-split, money is already confirmed against it, and the new total
  // exceeds that money. An unpaid bill never splits (nothing was paid), a bill
  // edited DOWNWARD never splits (nothing new is owed), and an already-split
  // group is handled by the tranche arithmetic above.
  if (members.length === 1 && groupConfirmed > 0 && newAmount > groupConfirmed) {
    await materializePaidShortTranches(db, { billId: rootId });
    cfbUpdated += 1;
  }

  return {
    ok: true,
    cfb_updated: cfbUpdated,
    apps_adjusted: appsAdjusted,
    wires_adjusted: wiresAdjusted.size,
    old_amount_cents: firstOld,
    new_amount_cents: newAmount,
  };
}
