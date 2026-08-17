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
import { resolveVendorBillPaymentTerms } from "../../../../../lib/purchase-orders/vendor-bill-payment-terms";
import {
  findDuplicateVendorBillReference,
  normalizeRequiredVendorBillReference,
  VENDOR_BILL_REFERENCE_REQUIRED_BODY,
} from "../../../../../lib/purchase-orders/vendor-bill-reference-uniqueness";
import {
  resolveRemainingPoQuantities,
  seedableLines,
} from "../../../../../lib/purchase-orders/po-billed-quantities";

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
  const referenceId = normalizeRequiredVendorBillReference(
    parsed.data.reference_id
  );
  if (!referenceId) {
    return res.status(422).json(VENDOR_BILL_REFERENCE_REQUIRED_BODY);
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
  const { days: paymentTermsDays, name: paymentTermsName } =
    await resolveVendorBillPaymentTerms(knex, po.vendor_id);

  // A PO may carry SEVERAL regular bills. A vendor that ships one order across
  // two deliveries invoices each one separately, and those invoices routinely
  // land before the goods do — so the split cannot be carried by item receipts
  // (there are none yet). It is carried by the quantities: this bill is seeded
  // with whatever the sibling bills have not claimed. The old guard rejected
  // outright on the FIRST existing bill without ever looking at quantities,
  // which made a partial vendor invoice impossible to record.
  //
  // Resolved INSIDE the transaction that inserts the lines: the remainder is
  // read-then-written, so reading it on the outer connection would let two
  // creates racing on the same PO both see the same free quantity and each
  // seed it in full.
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  const billId = `vb_${randomUUID().replace(/-/g, "")}`;
  try {
    const remainingLines = await resolveRemainingPoQuantities(
      db,
      purchaseOrderId
    );
    if (remainingLines.length === 0) {
      if (trx) await trx.rollback();
      return res.status(422).json({
        error: "Purchase order has no billable items",
        code: "no_open_lines",
      });
    }
    const poLines = seedableLines(remainingLines);
    if (poLines.length === 0) {
      const existing = await db.raw(
        `SELECT id, number
           FROM vendor_bill
          WHERE purchase_order_id = ?
            AND bill_type = 'regular'
            AND status IN ('draft', 'confirmed', 'synced')
            AND deleted_at IS NULL
          ORDER BY created_at
          LIMIT 1`,
        [purchaseOrderId]
      );
      const bill = existing.rows[0] as
        | { id: string; number: string | null }
        | undefined;
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: bill
          ? `Every ordered unit on this purchase order is already billed, starting with ${bill.number ?? bill.id}.`
          : "Every ordered unit on this purchase order is already billed.",
        code: "po_fully_billed",
        vendor_bill_id: bill?.id ?? null,
      });
    }

    const duplicate = await findDuplicateVendorBillReference(db, {
      vendorId: po.vendor_id,
      referenceId,
    });
    if (duplicate) {
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: `Purchase Invoice '${parsed.data.reference_id?.trim()}' already exists for this vendor on ${duplicate.number ?? "an adopted bill"}.`,
        code: "duplicate_vendor_invoice",
        duplicate_vendor_bill_id: duplicate.id,
        duplicate_vendor_bill_number: duplicate.number,
      });
    }

    const seq = await db.raw(
      `SELECT nextval('custom_vendor_bill_seq') AS seq`
    );
    const number = `VB-${String((seq.rows[0] as { seq: unknown }).seq)}`;
    await db.raw(
      `INSERT INTO vendor_bill (
         id, number, purchase_order_id, purchase_order_receipt_id,
         vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
         bill_type, status, reference_id, document_date,
         payment_terms_days, payment_terms_name, due_date, commission_mode,
         commission_rate_bps, commission_amount_cents,
         freight_included, freight_amount_cents,
         tariff_included, tariff_amount_cents, notes, created_at, updated_at
       ) VALUES (
         ?, ?, ?, NULL, ?, ?, ?, 'regular', 'draft', ?,
         COALESCE(?::timestamptz, NOW()), ?, ?,
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
        referenceId,
        parsed.data.document_date ?? null,
        paymentTermsDays,
        paymentTermsName,
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
          // The REMAINDER, not the ordered quantity: whatever the sibling
          // bills on this PO already claim stays on them.
          line.qty_remaining,
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
