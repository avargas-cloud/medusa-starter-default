import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../../purchase-orders/_lib/format";

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
    `SELECT id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot
     FROM purchase_order
     WHERE id = ? AND deleted_at IS NULL`,
    [parsed.data.purchase_order_id]
  );
  const po = (poResult.rows[0] ?? null) as
    | {
        id: string;
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

  const receiptResult = await knex.raw(
    `SELECT id
     FROM purchase_order_receipt
     WHERE purchase_order_id = ?
       AND status IN ('applied','synced')
       AND deleted_at IS NULL
     ORDER BY received_at ASC
     LIMIT 1`,
    [parsed.data.purchase_order_id]
  );
  const anchorReceipt = (receiptResult.rows[0] ?? null) as { id: string } | null;
  if (!anchorReceipt) {
    return res.status(422).json({
      error: "Purchase order has no applied receipts to bill",
      code: "no_receipts",
    });
  }

  const receiptLinesResult = await knex.raw(
    `WITH receipt_lines AS (
       SELECT
         porl.id AS receipt_line_id,
         porl.purchase_order_line_id,
         porl.product_variant_id,
         porl.sku_snapshot,
         porl.description_snapshot,
         porl.qty_received_now,
         COALESCE(porl.unit_cost_cents_override, pol.unit_cost_cents, 0) AS unit_cost_cents,
         pv.metadata
       FROM purchase_order_receipt por
       JOIN purchase_order_receipt_line porl
         ON porl.purchase_order_receipt_id = por.id AND porl.deleted_at IS NULL
       LEFT JOIN purchase_order_line pol
         ON pol.id = porl.purchase_order_line_id AND pol.deleted_at IS NULL
       LEFT JOIN product_variant pv
         ON pv.id = porl.product_variant_id AND pv.deleted_at IS NULL
       WHERE por.purchase_order_id = ?
         AND por.status IN ('applied','synced')
         AND por.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM vendor_bill_line vbl
           WHERE vbl.receipt_line_id = porl.id
             AND vbl.deleted_at IS NULL
         )
     )
     SELECT * FROM receipt_lines`,
    [parsed.data.purchase_order_id]
  );
  const receiptLines = receiptLinesResult.rows as Array<{
    receipt_line_id: string;
    product_variant_id: string;
    sku_snapshot: string;
    description_snapshot: string;
    qty_received_now: number;
    unit_cost_cents: number;
    metadata: Record<string, unknown> | null;
  }>;

  if (receiptLines.length === 0) {
    return res.status(409).json({
      error: "All received lines on this purchase order are already billed",
      code: "already_billed",
    });
  }

  const insertedRows: unknown[] = [];
  for (const line of receiptLines) {
    const cbmRaw = line.metadata?.cbm;
    const cbm = cbmRaw === undefined || cbmRaw === null || cbmRaw === ""
      ? null
      : Number(cbmRaw);
    const result = await knex.raw(
      `INSERT INTO vendor_bill_line (
       id,
       vendor_bill_id,
       receipt_line_id,
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
     VALUES (?, ?, ?, 'product', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NOW(), NOW())
     RETURNING *`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`,
        id,
        line.receipt_line_id,
        line.product_variant_id,
        line.sku_snapshot,
        typeof line.metadata?.mpn === "string" ? line.metadata.mpn : null,
        line.description_snapshot,
        line.qty_received_now,
        line.unit_cost_cents,
        cbm !== null && !Number.isNaN(cbm) ? cbm : null,
      ]
    );
    insertedRows.push(...result.rows);
  }

  await knex.raw(
    `UPDATE vendor_bill
     SET purchase_order_id = ?,
         purchase_order_receipt_id = ?,
         vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?),
         vendor_qb_list_id_snapshot = COALESCE(vendor_qb_list_id_snapshot, ?),
         updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [
      parsed.data.purchase_order_id,
      anchorReceipt.id,
      po.vendor_name_snapshot,
      po.vendor_qb_list_id_snapshot,
      id,
    ]
  );

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
