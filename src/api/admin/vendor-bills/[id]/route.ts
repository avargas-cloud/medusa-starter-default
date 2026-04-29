/**
 * src/api/admin/vendor-bills/[id]/route.ts
 *
 * GET    /admin/vendor-bills/:id
 *   Returns the full vendor bill detail with all lines plus PO / receipt
 *   display fields: po_number, receipt_number, vendor_name, receipt.received_at.
 *
 * DELETE /admin/vendor-bills/:id
 *   Hard-deletes a DRAFT vendor bill (and its lines via cascade). Confirmed
 *   bills cannot be deleted because they have already mutated
 *   product_variant.metadata.avg_landed_cost_cents.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface VendorBillDetailRow {
  id: string;
  number: string | null;
  purchase_order_id: string;
  purchase_order_receipt_id: string;
  status: string;
  reference_id: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  commission_invoice_number: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  freight_invoice_number: string | null;
  tariff_included: boolean;
  tariff_amount_cents: number;
  tariff_number: string | null;
  notes: string | null;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  po_number: string | null;
  receipt_number: string | null;
  vendor_name: string | null;
  receipt_received_at: string | null;
  ship_to_location_name: string | null;
}

interface VendorBillLineRow {
  id: string;
  vendor_bill_id: string;
  receipt_line_id: string;
  product_variant_id: string;
  sku: string;
  mpn: string | null;
  description: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const headerResult = await knex.raw(
    `SELECT
       vb.id,
       vb.number,
       vb.purchase_order_id,
       vb.purchase_order_receipt_id,
       vb.status,
       vb.reference_id,
       vb.commission_mode,
       vb.commission_rate_bps,
       vb.commission_amount_cents,
       vb.commission_invoice_number,
       vb.freight_included,
       vb.freight_amount_cents,
       vb.freight_invoice_number,
       vb.tariff_included,
       vb.tariff_amount_cents,
       vb.tariff_number,
       vb.notes,
       vb.confirmed_at,
       vb.confirmed_by_user_id,
       vb.created_at,
       vb.updated_at,
       po."number"                         AS po_number,
       por."number"                        AS receipt_number,
       po.vendor_name_snapshot             AS vendor_name,
       por.received_at                     AS receipt_received_at,
       sl.name                             AS ship_to_location_name
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     LEFT JOIN stock_location sl
       ON sl.id = por.stock_location_id AND sl.deleted_at IS NULL
     WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [id]
  );

  const header = (headerResult.rows[0] ?? null) as VendorBillDetailRow | null;
  if (!header) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT
       id,
       vendor_bill_id,
       receipt_line_id,
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
       landed_unit_cost_cents
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  const lines = linesResult.rows as VendorBillLineRow[];

  const total_landed_cents = lines.reduce(
    (s, l) => s + l.landed_unit_cost_cents * l.qty,
    0
  );

  return res.json({ vendor_bill: { ...header, total_landed_cents, lines } });
}

// ── DELETE — hard delete, draft only ─────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const lookup = (await knex.raw(
    `SELECT id, status FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  )) as { rows: Array<{ id: string; status: string }> };

  const existing = lookup.rows[0] ?? null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (existing.status !== "draft") {
    return res.status(409).json({
      error:
        "Only draft vendor bills can be deleted — confirmed bills have already affected variant landed-cost averages.",
      code: "not_draft",
    });
  }

  // FK on vendor_bill_line cascades — both rows + lines are removed.
  await knex.raw(`DELETE FROM vendor_bill WHERE id = ?`, [id]);

  return res.json({ id, deleted: true, hard: true });
}
