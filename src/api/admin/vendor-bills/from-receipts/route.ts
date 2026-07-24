/**
 * src/api/admin/vendor-bills/from-receipts/route.ts
 *
 * POST /admin/vendor-bills/from-receipts
 *
 * "From Item Receipts" bill creation (D6/D8, docs/VENDOR_BILL_QB_SYNC_PLAN.md
 * §1 D6/D8, §11): creates a new DRAFT regular vendor bill covering the UNION
 * of one-or-more `applied`/`synced` receipts of the SAME purchase order.
 * Nothing is sent to QB — this only stages the bill locally, same as the
 * existing single-receipt create path
 * (purchase-orders/[id]/receipts/[receiptId]/vendor-bill) and "Fill from PO".
 *
 * Body: { receipt_ids: string[] }  (non-empty; at least one receipt)
 *
 * Validation (in order):
 *   1. every id must exist, deleted_at NULL                → 404 receipt_not_found
 *   2. every receipt must share the SAME purchase_order_id → 400 receipts_span_multiple_pos
 *   3. every receipt must be applied/synced,
 *      and not already bound to a DIFFERENT bill           → delegated to
 *      validateReceiptsForBinding (409 receipt_not_applied / receipt_already_billed)
 *      once the single purchase_order_id is resolved — a receipt already
 *      bound to a different PO fails step 2 first with the clearer 400.
 *
 * The new bill's id is generated up front and passed as `billId` to
 * validateReceiptsForBinding so its "already bound to a DIFFERENT bill"
 * check works before the row exists (no receipt can already point at an id
 * that hasn't been inserted yet, so this is equivalent to validating against
 * a brand-new bill).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../purchase-orders/_lib/format";
import {
  resolveReceiptLineUnion,
  syncPrimaryReceiptPointer,
  validateReceiptsForBinding,
} from "../../../../lib/purchase-orders/vendor-bill-receipts";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
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
  receipt_ids: z.array(z.string().min(1)).min(1, "At least one receipt is required"),
});

interface ReceiptPoRow {
  id: string;
  purchase_order_id: string;
}

interface PurchaseOrderRow {
  id: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const receiptIds = [...new Set(parsed.data.receipt_ids)];

  const knex = resolveKnex(req);

  // ── Step 1 + 2: existence + single-PO check ────────────────────────────────
  const poLookup = await knex.raw(
    `SELECT id, purchase_order_id
       FROM purchase_order_receipt
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [receiptIds]
  );
  const poLookupRows = poLookup.rows as ReceiptPoRow[];
  const foundIds = new Set(poLookupRows.map((r) => r.id));
  const missingIds = receiptIds.filter((rid) => !foundIds.has(rid));
  if (missingIds.length > 0) {
    return res.status(404).json({
      error: `Receipt(s) not found: ${missingIds.join(", ")}`,
      code: "receipt_not_found",
      receipt_ids: missingIds,
    });
  }

  const distinctPoIds = [...new Set(poLookupRows.map((r) => r.purchase_order_id))];
  if (distinctPoIds.length > 1) {
    return res.status(400).json({
      error: "The selected receipts span multiple purchase orders. A vendor bill covers a single PO.",
      code: "receipts_span_multiple_pos",
      purchase_order_ids: distinctPoIds,
    });
  }
  // distinctPoIds has exactly 1 entry here — every id passed the existence
  // check above, so poLookupRows.length === receiptIds.length >= 1.
  const purchaseOrderId = distinctPoIds[0]!;

  // ── Step 3: status + already-billed (dual-read against a not-yet-existing
  // bill id — no receipt can already point at it, so this is equivalent to
  // "validate against a brand-new bill"). ─────────────────────────────────────
  const newBillId = `vb_${randomUUID().replace(/-/g, "")}`;
  const validation = await validateReceiptsForBinding(knex, {
    purchaseOrderId,
    billId: newBillId,
    receiptIds,
  });
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const poResult = await knex.raw(
    `SELECT id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [purchaseOrderId]
  );
  const po = (poResult.rows[0] ?? null) as PurchaseOrderRow | null;
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }

  // ── Union lines across the receipt set ──────────────────────────────────────
  const sourceLines = await resolveReceiptLineUnion(knex, receiptIds);
  if (sourceLines.length === 0) {
    return res.status(422).json({
      error: "The selected receipts have no billable lines",
      code: "no_lines",
    });
  }

  // ── Transaction: create bill, bind receipts, insert lines ──────────────────
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;

  try {
    const seqResult = await db.raw(`SELECT nextval('custom_vendor_bill_seq') AS seq`);
    const vbNumber = `VB-${(seqResult.rows[0] as { seq: string | number }).seq}`;

    // Mirrors the column/defaults shape of the existing create paths (top-level
    // POST /admin/vendor-bills and the legacy single-receipt
    // purchase-orders/[id]/receipts/[receiptId]/vendor-bill POST).
    // purchase_order_receipt_id (legacy pointer) starts NULL — set below via
    // syncPrimaryReceiptPointer once the receipts are bound (D6 dual-write).
    await db.raw(
      `INSERT INTO vendor_bill (
         id, number, purchase_order_receipt_id, purchase_order_id,
         vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
         bill_type, status, reference_id, document_date,
         commission_mode, commission_rate_bps, commission_amount_cents,
         freight_included, freight_amount_cents,
         tariff_included, tariff_amount_cents,
         notes, confirmed_at, confirmed_by_user_id,
         created_at, updated_at
       ) VALUES (
         ?, ?, NULL, ?,
         ?, ?, ?,
         'regular', 'draft', NULL, NOW(),
         'percent', 0, 0,
         false, 0,
         false, 0,
         NULL, NULL, NULL,
         NOW(), NOW()
       )`,
      [
        newBillId,
        vbNumber,
        purchaseOrderId,
        po.vendor_id,
        po.vendor_name_snapshot,
        po.vendor_qb_list_id_snapshot,
      ]
    );

    // Bind every receipt in the set (D6 dual-write: new FK + legacy mirror).
    await db.raw(
      `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
        WHERE id = ANY(?) AND deleted_at IS NULL`,
      [newBillId, receiptIds]
    );
    await syncPrimaryReceiptPointer(db, newBillId);

    // Insert bill lines — same shape sync-from-source uses for a newly-added
    // line (receipt_line_id NULL: a union spans multiple receipt lines, so no
    // single receipt line id applies; line_kind='po_item' per D6/D8 §3.2).
    for (const src of sourceLines) {
      const cbmRaw = src.metadata?.cbm;
      const cbm =
        cbmRaw === undefined || cbmRaw === null || cbmRaw === ""
          ? null
          : Number.isNaN(Number(cbmRaw))
            ? null
            : Number(cbmRaw);
      const mpn = typeof src.metadata?.mpn === "string" ? src.metadata.mpn : null;

      await db.raw(
        `INSERT INTO vendor_bill_line (
           id, vendor_bill_id, receipt_line_id, purchase_order_line_id,
           line_type, line_kind, product_variant_id, sku, mpn, description, qty,
           unit_cost_cents, cbm_per_unit,
           commission_per_unit_cents, freight_per_unit_cents,
           tariff_per_unit_cents, landed_unit_cost_cents,
           created_at, updated_at
         )
         VALUES (?, ?, NULL, ?, 'product', 'po_item', ?, ?, ?, ?, ?, ?, ?::float, 0, 0, 0, 0, NOW(), NOW())`,
        [
          `vbl_${randomUUID().replace(/-/g, "")}`,
          newBillId,
          src.purchase_order_line_id,
          src.product_variant_id,
          src.sku,
          mpn,
          src.description,
          src.qty,
          src.unit_cost_cents,
          cbm,
        ]
      );
    }

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return res.status(201).json({ vendor_bill_id: newBillId });
}
