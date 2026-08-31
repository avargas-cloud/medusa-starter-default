import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../../purchase-orders/_lib/format";
import { syncPrimaryReceiptPointer } from "../../../../../lib/purchase-orders/vendor-bill-receipts";
import {
  resolveRemainingPoQuantities,
  seedableLines,
} from "../../../../../lib/purchase-orders/po-billed-quantities";
import { loadConfirmReceiptFacts } from "../../../../../lib/purchase-orders/po-receipt-completeness";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

const bodySchema = z.object({
  purchase_order_id: z.string().min(1),
});

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);
  const billResult = await knex.raw(
    `SELECT id, status, bill_type, vendor_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as
    | { id: string; status: string; bill_type: string; vendor_id: string | null }
    | null;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status !== "draft" && bill.status !== "confirmed") {
    return res.status(409).json({
      error: "Only draft or confirmed vendor bills can be edited",
      code: "not_editable",
    });
  }
  if (bill.bill_type !== "regular") {
    return res.status(422).json({
      error: "Only regular bills can be filled from purchase orders",
      code: "wrong_bill_type",
    });
  }

  const poResult = await knex.raw(
    `SELECT id, status, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot
     FROM purchase_order
     WHERE id = ? AND deleted_at IS NULL`,
    [parsed.data.purchase_order_id]
  );
  const po = (poResult.rows[0] ?? null) as
    | {
        id: string;
        status: string;
        vendor_id: string;
        vendor_name_snapshot: string | null;
        vendor_qb_list_id_snapshot: string | null;
      }
    | null;
  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "po_not_found" });
  }
  if (!bill.vendor_id) {
    return res.status(422).json({
      error: "Select a vendor on this bill before filling it from a purchase order",
      code: "vendor_required",
    });
  }
  if (bill.vendor_id !== po.vendor_id) {
    return res.status(422).json({
      error: "Purchase order vendor must match the selected vendor bill vendor",
      code: "vendor_mismatch",
    });
  }
  // A fully received PO is normally done being billed, so it is excluded here.
  //
  // A PURCHASING-AGENT purchase order is the exact inverse (2026-08-31): its
  // bill may only be CONFIRMED once the PO has arrived in full, so "fully
  // received" is precisely when its bill gets built. Keeping the exclusion for
  // it would leave the operator unable to seed the lines at the only moment the
  // document is allowed to exist — a dead end created by the two rules meeting,
  // not by either one alone.
  const agentFacts = await loadConfirmReceiptFacts(knex as never, id);
  const isAgentPo = Boolean(
    agentFacts?.is_agent_purchase && agentFacts.has_purchase_order
  );
  if (!isAgentPo && !["submitted", "partially_received"].includes(po.status)) {
    return res.status(422).json({
      error: "Only open purchase orders can be used. Fully received purchase orders are excluded.",
      code: "po_not_open",
    });
  }

  // Option A: a PO can carry one regular bill PER RECEIPT (shipment), so we no
  // longer block when another regular bill already exists for the PO. The
  // per-receipt UNIQUE(purchase_order_receipt_id) index is the real guard; the
  // anchor-receipt query below skips receipts already pinned to another bill.

  const existingLineResult = await knex.raw(
    `SELECT 1
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id]
  );
  if (existingLineResult.rows.length > 0) {
    return res.status(409).json({
      error: "This vendor bill already has lines",
      code: "bill_has_lines",
    });
  }

  // D8(a): "Fill from PO" builds a PO-ordered DRAFT and binds NO receipts.
  // (It used to auto-pin an "anchor" receipt — an Option A relic. Under the
  // context-aware D6 model that accidental binding made the Rcv'd column and
  // the drift engine compare the WHOLE-PO bill against ONE receipt: a bill
  // claiming the full order showed "claims $X more than RCP-####" the moment
  // it was created — seen live on VB-1068. Receipts now enter the picture at
  // confirm time — which resolves the PO's applied receipts and requires the
  // billed quantities to be fully received — or explicitly via "Fill from
  // Receipts" / the receipt chips.)

  // Seeded with the REMAINDER, not the full order. A PO can carry several
  // regular bills (one per vendor invoice on a split delivery), so whatever
  // the sibling bills already claim has to stay on them — otherwise attaching
  // a PO to a second bill silently doubles every quantity. `id` excludes this
  // bill from its own sum; it has no lines yet here, but that stays true if
  // this route is ever reached with lines present.
  const remainingLines = await resolveRemainingPoQuantities(
    knex,
    parsed.data.purchase_order_id,
    id
  );
  const poLines = seedableLines(remainingLines);

  if (poLines.length === 0) {
    return res.status(409).json({
      error:
        remainingLines.length === 0
          ? "Purchase order has no open lines to bill"
          : "Every ordered unit on this purchase order is already billed on another bill.",
      code:
        remainingLines.length === 0 ? "no_open_lines" : "po_fully_billed",
    });
  }

  const insertedRows: unknown[] = [];
  for (const line of poLines) {
    const cbmRaw = line.metadata?.cbm;
    const cbm = cbmRaw === undefined || cbmRaw === null || cbmRaw === ""
      ? null
      : Number(cbmRaw);
    const result = await knex.raw(
      `INSERT INTO vendor_bill_line (
       id,
       vendor_bill_id,
       receipt_line_id,
       purchase_order_line_id,
       line_type,
       product_variant_id,
       sku,
       mpn,
       description,
       qty,
       unit_cost_cents,
       cbm_per_unit,
       commission_per_unit_cents,
       freight_per_unit_cents,
       tariff_per_unit_cents,
       landed_unit_cost_cents,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NOW(), NOW())
     RETURNING *`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`,
        id,
        null,
        line.purchase_order_line_id,
        line.product_variant_id,
        line.sku_snapshot,
        typeof line.metadata?.mpn === "string" ? line.metadata.mpn : null,
        line.description_snapshot,
        line.qty_remaining,
        line.unit_cost_cents,
        cbm !== null && !Number.isNaN(cbm) ? cbm : null,
      ]
    );
    insertedRows.push(...result.rows);
  }

  await knex.raw(
    `UPDATE vendor_bill
     SET purchase_order_id = ?,
         vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?),
         vendor_qb_list_id_snapshot = COALESCE(vendor_qb_list_id_snapshot, ?),
         updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [
      parsed.data.purchase_order_id,
      po.vendor_name_snapshot,
      po.vendor_qb_list_id_snapshot,
      id,
    ]
  );
  // Keep the legacy mirror consistent with whatever is (not) bound — for a
  // fresh fill-from-po bill this simply leaves both sides NULL (no receipts).
  await syncPrimaryReceiptPointer(knex, id);

  await knex.raw(
    `UPDATE vendor_bill linked
     SET purchase_order_id = ?, updated_at = NOW()
     FROM vendor_bill regular
     WHERE regular.id = ?
       AND regular.deleted_at IS NULL
       AND linked.deleted_at IS NULL
       AND linked.id IN (
         regular.service_vendor_bill_id,
         regular.freight_vendor_bill_id,
         regular.tariff_vendor_bill_id
       )`,
    [parsed.data.purchase_order_id, id]
  );

  return res.status(201).json({
    vendor_bill_id: id,
    inserted_lines: insertedRows.length,
  });
}
