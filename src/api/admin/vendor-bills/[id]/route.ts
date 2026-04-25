/**
 * src/api/admin/vendor-bills/[id]/route.ts
 *
 * GET /admin/vendor-bills/:id
 *
 * Returns the full vendor bill detail with all lines plus PO / receipt
 * display fields: po_number, receipt_number, vendor_name, receipt.received_at.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface VendorBillDetailRow {
  id: string;
  purchase_order_id: string;
  purchase_order_receipt_id: string;
  status: string;
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
  received_at: string | null;
}

interface VendorBillLineRow {
  id: string;
  vendor_bill_id: string;
  receipt_line_id: string;
  product_variant_id: string;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
}

// ── GET handler ──────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  // Fetch header with PO + receipt join
  const headerResult = await knex.raw(
    `SELECT
       vb.id,
       vb.purchase_order_id,
       vb.purchase_order_receipt_id,
       vb.status,
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
       po.vendor_name_snapshot              AS vendor_name,
       por.received_at
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     WHERE vb.id = $1 AND vb.deleted_at IS NULL`,
    [id]
  );

  const header = (headerResult.rows[0] ?? null) as VendorBillDetailRow | null;
  if (!header) {
    return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
  }

  // Fetch lines
  const linesResult = await knex.raw(
    `SELECT
       id,
       vendor_bill_id,
       receipt_line_id,
       product_variant_id,
       sku,
       description,
       qty,
       unit_cost_cents,
       cbm_per_unit,
       commission_per_unit_cents,
       freight_per_unit_cents,
       tariff_per_unit_cents,
       landed_unit_cost_cents
     FROM vendor_bill_line
     WHERE vendor_bill_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  const lines = linesResult.rows as VendorBillLineRow[];

  return res.json({ vendor_bill: { ...header, lines } });
}
