/**
 * src/api/admin/purchase-orders/[id]/propagate-line-quantities/route.ts
 *
 * POST /admin/purchase-orders/:id/propagate-line-quantities
 *
 * Pushes a PO line's corrected QUANTITY down onto the draft vendor bill lines
 * raised against it. The exact sibling of `propagate-line-costs`, which does
 * this for unit cost and says in its own header that "Quantities, receipts and
 * bindings are untouched" — this route fills that gap, and only that gap.
 *
 * WHY (2026-08-04): a vendor invoices before the goods ship, so a draft bill
 * routinely claims quantities the PO is still being corrected toward. When the
 * PO is reduced to what actually arrived, the draft is left claiming more, and
 * until now the only outcome was a drift banner and a manual second edit. The
 * operator corrects one document; the pair should end up agreeing.
 *
 * Deliberately narrow, same as the cost route:
 *   - DRAFT regular bills only. A confirmed/synced bill has moved average costs
 *     and posted to QuickBooks; changing its quantities is a Reopen → edit →
 *     Reconfirm decision, never a side effect of saving a PO. Non-draft bills
 *     come back in `skipped`, never silently ignored.
 *   - Product lines only, matched by purchase_order_line_id.
 *   - Quantities only. Costs, receipts and bindings are untouched.
 *
 * A line reduced to ZERO is REMOVED from the bill (owner decision,
 * 2026-08-04). That is a deliberate exception to "a Save never deletes rows":
 * this route is NOT the Save — it runs after it, only when the operator
 * confirms a modal that names each line being removed. The rule exists to stop
 * a save from silently discarding work in progress; here the removal is the
 * thing being asked about. The delete is SOFT (`deleted_at`), so the row stays
 * recoverable and every reader already filters it out.
 *
 * Landed-cost snapshots on touched lines are zeroed exactly as the cost route
 * does — they are outputs of a confirm, and the inputs just moved.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { recomputeBillFinanceLinks } from "../../../../../lib/finance/recompute-bill-finance";

type Knex = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): Knex {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as Knex;
}

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        purchase_order_line_id: z.string().min(1),
        qty: z.number().int().min(0).max(1_000_000),
      })
    )
    .min(1),
});

interface TargetRow {
  vendor_bill_line_id: string;
  vendor_bill_id: string;
  vendor_bill_number: string | null;
  vendor_bill_status: string;
  purchase_order_line_id: string;
  sku: string | null;
  qty: number;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res.status(401).json({ error: error.message });
    }
    throw error;
  }

  const { id } = req.params as { id: string };
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);
  const wantedByPoLine = new Map(
    parsed.data.lines.map((l) => [l.purchase_order_line_id, Math.round(l.qty)])
  );
  const poLineIds = [...wantedByPoLine.keys()];

  // Every active regular bill line for these PO lines, whatever the bill's
  // status — the non-draft ones become the `skipped` report below.
  const targetsResult = await knex.raw(
    `SELECT vbl.id AS vendor_bill_line_id,
            vbl.vendor_bill_id,
            vbl.purchase_order_line_id,
            vbl.sku,
            COALESCE(vbl.qty, 0)::int AS qty,
            vb.number AS vendor_bill_number,
            vb.status AS vendor_bill_status
       FROM vendor_bill_line vbl
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.purchase_order_id = ?
        AND vb.bill_type = 'regular'
        AND vb.status NOT IN ('cancelled', 'voided', 'deleted')
      WHERE vbl.deleted_at IS NULL
        AND COALESCE(vbl.line_type, 'product') = 'product'
        AND vbl.purchase_order_line_id = ANY(?)
      ORDER BY vbl.id`,
    [id, poLineIds]
  );
  const targets = targetsResult.rows as TargetRow[];

  const skipped = targets
    .filter((t) => t.vendor_bill_status !== "draft")
    .map((t) => ({
      vendor_bill_id: t.vendor_bill_id,
      vendor_bill_number: t.vendor_bill_number,
      status: t.vendor_bill_status,
      reason: "bill_not_draft",
    }));

  const toChange = targets.filter(
    (t) =>
      t.vendor_bill_status === "draft" &&
      wantedByPoLine.get(t.purchase_order_line_id) !== t.qty
  );

  if (toChange.length === 0) {
    return res.json({
      updated_bills: [],
      updated_lines: 0,
      removed_lines: 0,
      skipped,
    });
  }

  const toRemove = toChange.filter(
    (t) => wantedByPoLine.get(t.purchase_order_line_id) === 0
  );
  const toUpdate = toChange.filter(
    (t) => wantedByPoLine.get(t.purchase_order_line_id) !== 0
  );

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    for (const target of toUpdate) {
      const next = wantedByPoLine.get(target.purchase_order_line_id)!;
      await db.raw(
        `UPDATE vendor_bill_line
            SET qty = ?,
                commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                tariff_per_unit_cents = 0, tax_per_unit_cents = 0,
                landed_unit_cost_cents = 0, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [next, target.vendor_bill_line_id]
      );
    }

    // SOFT delete: the row survives for audit and every reader already filters
    // `deleted_at IS NULL`. The operator confirmed these by name in the modal.
    for (const target of toRemove) {
      await db.raw(
        `UPDATE vendor_bill_line
            SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [target.vendor_bill_line_id]
      );
    }

    // One recompute per touched bill — the line totals it derives from moved.
    const touchedBillIds = [...new Set(toChange.map((t) => t.vendor_bill_id))];
    for (const billId of touchedBillIds) {
      const recompute = await recomputeBillFinanceLinks(db, billId);
      if (!recompute.ok) {
        if (trx) await trx.rollback();
        return res.status(409).json({
          error: recompute.message,
          code: recompute.code,
          conflicts: recompute.conflicts,
          vendor_bill_id: billId,
        });
      }
    }

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  const byBill = new Map<
    string,
    {
      vendor_bill_id: string;
      vendor_bill_number: string | null;
      lines: number;
      removed: number;
    }
  >();
  for (const target of toChange) {
    const entry = byBill.get(target.vendor_bill_id) ?? {
      vendor_bill_id: target.vendor_bill_id,
      vendor_bill_number: target.vendor_bill_number,
      lines: 0,
      removed: 0,
    };
    if (wantedByPoLine.get(target.purchase_order_line_id) === 0) {
      entry.removed += 1;
    } else {
      entry.lines += 1;
    }
    byBill.set(target.vendor_bill_id, entry);
  }

  return res.json({
    updated_bills: [...byBill.values()],
    updated_lines: toUpdate.length,
    removed_lines: toRemove.length,
    skipped,
  });
}
