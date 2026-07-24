import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import {
  getActorUserId,
  UnauthenticatedError,
} from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { resolveVendorBillPaymentTermsDays } from "../../../../../lib/purchase-orders/vendor-bill-payment-terms";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const bodySchema = z.object({
  reference_id: z.string().max(200).nullish(),
  document_date: z.string().datetime().nullish(),
  commission_mode: z.enum(["percent", "fixed"]).default("percent"),
  notes: z.string().max(2000).nullish(),
});

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { id: purchaseOrderId } = req.params as { id: string };
  const knex = (req.scope as unknown as { resolve: (key: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const poResult = await knex.raw(
    `SELECT id, status, vendor_id, vendor_name_snapshot,
            vendor_qb_list_id_snapshot
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [purchaseOrderId]
  );
  const po = poResult.rows[0] as
    | {
        id: string;
        status: string;
        vendor_id: string | null;
        vendor_name_snapshot: string | null;
        vendor_qb_list_id_snapshot: string | null;
      }
    | undefined;
  if (!po) {
    return res.status(404).json({
      error: "Purchase order not found",
      code: "po_not_found",
    });
  }
  if (!["submitted", "partially_received", "received"].includes(po.status)) {
    return res.status(422).json({
      error: "Only submitted or received purchase orders can be billed",
      code: "po_not_billable",
    });
  }
  if (!po.vendor_id) {
    return res.status(422).json({
      error: "Purchase order has no vendor",
      code: "vendor_required",
    });
  }
  const paymentTermsDays = await resolveVendorBillPaymentTermsDays(
    knex,
    po.vendor_id
  );

  const existing = await knex.raw(
    `SELECT id, number
       FROM vendor_bill
      WHERE purchase_order_id = ?
        AND bill_type = 'regular'
        AND deleted_at IS NULL
      LIMIT 1`,
    [purchaseOrderId]
  );
  if (existing.rows.length > 0) {
    const bill = existing.rows[0] as { id: string; number: string | null };
    return res.status(409).json({
      error: `This purchase order already has Regular Bill ${bill.number ?? bill.id}`,
      code: "po_regular_bill_exists",
      vendor_bill_id: bill.id,
    });
  }

  const linesResult = await knex.raw(
    `SELECT pol.id AS purchase_order_line_id, pol.product_variant_id,
            pol.sku_snapshot, pol.description_snapshot,
            GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int AS qty,
            COALESCE(pol.unit_cost_cents, 0)::int AS unit_cost_cents,
            pv.metadata
       FROM purchase_order_line pol
       LEFT JOIN product_variant pv
         ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
      WHERE pol.purchase_order_id = ?
        AND pol.deleted_at IS NULL
        AND COALESCE(pol.status, 'open') <> 'cancelled'
        AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) > 0
      ORDER BY pol.created_at, pol.id`,
    [purchaseOrderId]
  );
  const poLines = linesResult.rows as Array<{
    purchase_order_line_id: string;
    product_variant_id: string;
    sku_snapshot: string;
    description_snapshot: string;
    qty: number;
    unit_cost_cents: number;
    metadata: Record<string, unknown> | null;
  }>;
  if (poLines.length === 0) {
    return res.status(422).json({
      error: "Purchase order has no billable items",
      code: "no_open_lines",
    });
  }

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  const billId = `vb_${randomUUID().replace(/-/g, "")}`;
  try {
    const seq = await db.raw(
      `SELECT nextval('custom_vendor_bill_seq') AS seq`
    );
    const number = `VB-${String((seq.rows[0] as { seq: unknown }).seq)}`;
    await db.raw(
      `INSERT INTO vendor_bill (
         id, number, purchase_order_id, purchase_order_receipt_id,
         vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
         bill_type, status, reference_id, document_date,
         payment_terms_days, due_date, commission_mode,
         commission_rate_bps, commission_amount_cents,
         freight_included, freight_amount_cents,
         tariff_included, tariff_amount_cents, notes, created_at, updated_at
       ) VALUES (
         ?, ?, ?, NULL, ?, ?, ?, 'regular', 'draft', ?,
         COALESCE(?::timestamptz, NOW()), ?,
         COALESCE(?::timestamptz, NOW()) + (? * INTERVAL '1 day'),
         ?, 0, 0, false, 0, false, 0, ?,
         NOW(), NOW()
       )`,
      [
        billId,
        number,
        purchaseOrderId,
        po.vendor_id,
        po.vendor_name_snapshot,
        po.vendor_qb_list_id_snapshot,
        parsed.data.reference_id ?? null,
        parsed.data.document_date ?? null,
        paymentTermsDays,
        parsed.data.document_date ?? null,
        paymentTermsDays,
        parsed.data.commission_mode,
        parsed.data.notes ?? null,
      ]
    );
    for (const line of poLines) {
      const cbmRaw = line.metadata?.cbm;
      const cbm =
        cbmRaw == null || cbmRaw === "" || !Number.isFinite(Number(cbmRaw))
          ? null
          : Number(cbmRaw);
      await db.raw(
        `INSERT INTO vendor_bill_line (
           id, vendor_bill_id, receipt_line_id, purchase_order_line_id,
           line_type, line_kind, product_variant_id, sku, mpn, description,
           qty, unit_cost_cents, cbm_per_unit,
           commission_per_unit_cents, freight_per_unit_cents,
           tariff_per_unit_cents, landed_unit_cost_cents, created_at, updated_at
         ) VALUES (
           ?, ?, NULL, ?, 'product', 'po_item', ?, ?, ?, ?, ?, ?, ?,
           0, 0, 0, 0, NOW(), NOW()
         )`,
        [
          `vbl_${randomUUID().replace(/-/g, "")}`,
          billId,
          line.purchase_order_line_id,
          line.product_variant_id,
          line.sku_snapshot,
          typeof line.metadata?.mpn === "string" ? line.metadata.mpn : null,
          line.description_snapshot,
          line.qty,
          line.unit_cost_cents,
          cbm,
        ]
      );
    }
    if (trx) await trx.commit();
  } catch (error) {
    if (trx) await trx.rollback();
    throw error;
  }

  const created = await knex.raw(
    `SELECT * FROM vendor_bill WHERE id = ?`,
    [billId]
  );
  const createdLines = await knex.raw(
    `SELECT * FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [billId]
  );
  return res.status(201).json({
    vendor_bill: {
      ...(created.rows[0] as Record<string, unknown>),
      lines: createdLines.rows,
      line_count: createdLines.rows.length,
    },
  });
}
