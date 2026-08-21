/**
 * src/api/admin/purchase-orders/[id]/propagate-line-costs/route.ts
 *
 * POST /admin/purchase-orders/:id/propagate-line-costs
 *
 * Pushes a PO line's corrected unit cost DOWN onto the draft vendor bill lines
 * raised against it. The mirror of the bill→PO direction that lives in the
 * vendor-bill PATCH (lib/purchase-orders/po-cost-propagation.ts): whichever
 * document the operator corrects, the pair ends up agreeing, so the drift
 * engine has nothing to report.
 *
 * Deliberately narrow:
 *   - DRAFT regular bills only. A confirmed/synced bill has already moved
 *     average costs and posted to QuickBooks; changing its cost is a Reopen →
 *     edit → Reconfirm decision, never a side effect of saving a PO. Bills in
 *     any other state are reported back as `skipped`, never silently ignored.
 *   - Product lines only, matched by purchase_order_line_id.
 *   - Costs only. Quantities, receipts and bindings are untouched.
 *
 * Landed-cost snapshots on the touched lines are zeroed exactly as the bill's
 * own PATCH does — they are outputs of a confirm, and the inputs just moved.
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
        unit_cost_cents: z.number().int().min(0).max(1_000_000_000),
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
  unit_cost_cents: number;
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
    parsed.data.lines.map((l) => [
      l.purchase_order_line_id,
      Math.round(l.unit_cost_cents),
    ])
  );
  const poLineIds = [...wantedByPoLine.keys()];

  // Every active regular bill line for these PO lines, whatever the bill's
  // status — the non-draft ones become the `skipped` report below.
  const targetsResult = await knex.raw(
    `SELECT vbl.id AS vendor_bill_line_id,
            vbl.vendor_bill_id,
            vbl.purchase_order_line_id,
            vbl.unit_cost_cents::int AS unit_cost_cents,
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
        AND vbl.purchase_order_line_id = ANY(?)`,
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

  const toUpdate = targets.filter(
    (t) =>
      t.vendor_bill_status === "draft" &&
      wantedByPoLine.get(t.purchase_order_line_id) !== t.unit_cost_cents
  );

  if (toUpdate.length === 0) {
    return res.json({ updated_bills: [], updated_lines: 0, skipped });
  }

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    for (const target of toUpdate) {
      const next = wantedByPoLine.get(target.purchase_order_line_id)!;
      await db.raw(
        `UPDATE vendor_bill_line
            SET unit_cost_cents = ?,
                commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                tariff_per_unit_cents = 0, tax_per_unit_cents = 0,
                landed_unit_cost_cents = 0, landed_total_cents = NULL, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [next, target.vendor_bill_line_id]
      );
    }

    // One recompute per touched bill — the line total it derives from moved.
    const touchedBillIds = [...new Set(toUpdate.map((t) => t.vendor_bill_id))];
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

  const byBill = new Map<string, { vendor_bill_id: string; vendor_bill_number: string | null; lines: number }>();
  for (const target of toUpdate) {
    const entry = byBill.get(target.vendor_bill_id) ?? {
      vendor_bill_id: target.vendor_bill_id,
      vendor_bill_number: target.vendor_bill_number,
      lines: 0,
    };
    entry.lines += 1;
    byBill.set(target.vendor_bill_id, entry);
  }

  return res.json({
    updated_bills: [...byBill.values()],
    updated_lines: toUpdate.length,
    skipped,
  });
}
