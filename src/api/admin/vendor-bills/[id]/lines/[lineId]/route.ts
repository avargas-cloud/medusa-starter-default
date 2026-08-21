/**
 * PATCH  /admin/vendor-bills/:id/lines/:lineId
 *   - qb_account lines: edit amount/description (draft or confirmed).
 *   - product lines: edit qty (Phase 2 — draft only, pre-receipt window).
 * DELETE /admin/vendor-bills/:id/lines/:lineId
 *   Removes one line from an editable vendor bill.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../../../purchase-orders/_lib/format";
import { enqueueVendorBillModSingle } from "../../../../../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";
import { getPurchaseOrdersService } from "../../../../purchase-orders/_lib/service-resolver";
import { recomputeBillFinanceLinks } from "../../../../../../lib/finance/recompute-bill-finance";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    KnexInstance & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const patchSchema = z.object({
  amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  description: z.string().max(500).optional(),
  qty: z.number().int().min(0).max(1_000_000).optional(),
});

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

function isEditableStatus(status: string) {
  return status === "draft" || status === "confirmed";
}

type LineBillRow = {
  status: string;
  bill_type: string;
  purchase_order_id: string | null;
  purchase_order_receipt_id: string | null;
  vendor_bill_id: string;
  line_id: string;
  line_type: string;
  line_purchase_order_line_id: string | null;
};

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);
  const result = await knex.raw(
    `SELECT
       vb.id AS vendor_bill_id,
       vb.status,
       vb.bill_type,
       vb.purchase_order_id,
       vb.purchase_order_receipt_id,
       vbl.id AS line_id,
       vbl.line_type,
       vbl.purchase_order_line_id AS line_purchase_order_line_id
     FROM vendor_bill vb
     JOIN vendor_bill_line vbl
       ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
     WHERE vb.id = ?
       AND vbl.id = ?
       AND vb.deleted_at IS NULL`,
    [id, lineId]
  );
  const row = (result.rows[0] ?? null) as LineBillRow | null;
  if (!row) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }

  // ── Product line qty edit (Phase 2) ─────────────────────────────────────────
  if (parsed.data.qty !== undefined) {
    if ((row.line_type ?? "product") !== "product") {
      return res.status(422).json({
        error: "Quantity can only be edited on product lines",
        code: "wrong_line_type",
      });
    }
    if (row.status !== "draft") {
      return res.status(409).json({
        error: "Quantities can only be edited on draft vendor bills",
        code: "not_draft",
      });
    }
    // Pre-receipt planning window only: once the bill is pinned to a receipt the
    // qty must equal the received qty — reconcile via "Update from Receipt".
    if (row.purchase_order_receipt_id) {
      return res.status(409).json({
        error:
          "This bill is pinned to a receipt. Use 'Update from Receipt' to match the received quantity.",
        code: "bill_receipt_pinned",
      });
    }
    if (!row.line_purchase_order_line_id) {
      return res.status(422).json({
        error: "Cannot determine this line's purchase order line to validate the quantity cap",
        code: "no_po_line",
      });
    }

    // Never edit qty while real money has moved (application on a confirmed wire).
    const confirmedWire = await knex.raw(
      `SELECT 1
         FROM china_finance_bill cfb
         JOIN china_wire_transfer_application cwta ON cwta.bill_id = cfb.id
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cfb.vendor_bill_id = ? AND cwt.status = 'confirmed'
        LIMIT 1`,
      [row.vendor_bill_id]
    );
    if (confirmedWire.rows.length > 0) {
      return res.status(409).json({
        error: "This bill is already paid by a confirmed wire and can't be edited",
        code: "on_confirmed_wire",
      });
    }

    // Cap = PO line ordered qty (qty_ordered − qty_cancelled).
    const polResult = await knex.raw(
      `SELECT GREATEST(qty_ordered - COALESCE(qty_cancelled, 0), 0)::int AS po_qty
         FROM purchase_order_line WHERE id = ? AND deleted_at IS NULL`,
      [row.line_purchase_order_line_id]
    );
    const poQty = Number(
      (polResult.rows[0] as { po_qty?: number } | undefined)?.po_qty ?? 0
    );
    if (parsed.data.qty > poQty) {
      return res.status(422).json({
        error: `Max is the PO quantity (${poQty}). Edit the purchase order to add more.`,
        code: "qty_exceeds_po",
        po_qty: poQty,
      });
    }

    const trx = knex.transaction ? await knex.transaction() : null;
    const db = trx ?? knex;
    try {
      const updated = await db.raw(
        `UPDATE vendor_bill_line
            SET qty = ?,
                commission_per_unit_cents = 0,
                freight_per_unit_cents = 0,
                tariff_per_unit_cents = 0,
                tax_per_unit_cents = 0,
                landed_unit_cost_cents = 0,
                landed_total_cents = NULL,
                updated_at = NOW()
          WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL
          RETURNING *`,
        [parsed.data.qty, lineId, id]
      );

      const recompute = await recomputeBillFinanceLinks(db, row.vendor_bill_id);
      if (!recompute.ok) {
        if (trx) await trx.rollback();
        return res.status(409).json({
          error: recompute.message,
          code: recompute.code,
          conflicts: recompute.conflicts,
        });
      }

      if (trx) await trx.commit();
      return res.json({ vendor_bill_line: updated.rows[0] ?? null });
    } catch (err) {
      if (trx) await trx.rollback();
      throw err;
    }
  }

  // ── Account line amount / description edit (existing behaviour) ──────────────
  if (!isEditableStatus(row.status)) {
    return res.status(409).json({
      error: "Only draft or confirmed vendor bills can be edited",
      code: "not_editable",
    });
  }
  if (row.line_type !== "qb_account") {
    return res.status(422).json({
      error: "Only account line amounts can be edited here",
      code: "wrong_line_type",
    });
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];
  if (parsed.data.amount_cents !== undefined) {
    updates.push("unit_cost_cents = ?");
    bindings.push(parsed.data.amount_cents);
    updates.push("landed_unit_cost_cents = ?");
    bindings.push(parsed.data.amount_cents);
    updates.push("landed_total_cents = ?");
    bindings.push(parsed.data.amount_cents);
  }
  if (parsed.data.description !== undefined) {
    updates.push("description = ?");
    bindings.push(parsed.data.description);
  }
  if (updates.length === 0) {
    return res.status(400).json({
      error: "No editable fields were provided",
      code: "empty_update",
    });
  }

  const updated = await knex.raw(
    `UPDATE vendor_bill_line
     SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = ?
       AND vendor_bill_id = ?
       AND deleted_at IS NULL
     RETURNING *`,
    [...bindings, lineId, id]
  );

  // Tell QuickBooks. This route is how a service / freight / tariff bill's
  // amount is actually edited — the bill PATCH refuses non-regular line edits,
  // so everything comes through here — and until 2026-08-04 it wrote the row
  // and returned. VB-1061 went from $328.60 to $346.43 in the POS while
  // QuickBooks kept quoting the old figure, with nothing on any screen or in
  // any log to say the two had parted ways.
  //
  // Only a bill that already LIVES in QuickBooks gets a Mod. One that has not
  // been sent yet needs nothing here: its Add goes out when it is confirmed.
  //
  // Sent ALONE, never as the sibling group (owner decision): the group Mod
  // would drag the regular bill along, and that one may be mid-repair. The
  // trade-off is that the regular's negative clearing lines keep quoting the
  // old amount until it is re-sent — which is what its resync flag is for.
  let qbSync: { queued: boolean; reason?: string } = { queued: false };
  if (row.line_type === "qb_account") {
    try {
      const billRow = await knex.raw(
        `SELECT qb_txn_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
        [id]
      );
      const qbTxnId = (
        billRow.rows[0] as { qb_txn_id: string | null } | undefined
      )?.qb_txn_id;
      if (qbTxnId) {
        qbSync = await enqueueVendorBillModSingle(knex as never, id);
      }
    } catch (qbErr) {
      // The line is already saved and correct; a failed enqueue must not undo
      // it. Reported rather than swallowed — a silent catch here is precisely
      // how the gap stayed invisible for eleven days.
      console.error("[vendor-bill-line] QB Mod enqueue failed:", qbErr);
      qbSync = {
        queued: false,
        reason: qbErr instanceof Error ? qbErr.message : "enqueue failed",
      };
    }
  }

  return res.json({
    vendor_bill_line: updated.rows[0] ?? null,
    qb_sync: qbSync,
  });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const service = getPurchaseOrdersService(req);

  const bills = (await service.listVendorBills(
    { id },
    { take: 1 }
  )) as unknown as Array<{ id: string; status: string; bill_type?: string }>;
  const bill = bills[0] ?? null;

  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (!isEditableStatus(bill.status)) {
    return res.status(409).json({
      error: "Only draft or confirmed vendor bills can have lines removed",
      code: "not_editable",
    });
  }

  const lines = (await service.listVendorBillLines(
    { vendor_bill_id: id },
    { take: 1000 }
  )) as unknown as Array<{ id: string }>;

  const line = lines.find((candidate) => candidate.id === lineId);
  if (!line) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }

  if ((bill.bill_type ?? "regular") === "regular" && lines.length <= 1) {
    return res.status(422).json({
      error: "Vendor bill must keep at least one line",
      code: "last_line",
    });
  }

  await service.deleteVendorBillLines(lineId);

  return res.json({
    id: lineId,
    deleted: true,
    remaining_lines: lines.length - 1,
  });
}
