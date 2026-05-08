/**
 * src/api/admin/vendor-bills/route.ts
 *
 * GET /admin/vendor-bills
 *
 * Returns a paginated list of all vendor bills with embedded PO and receipt
 * summary data. Supports filtering by status and po_id.
 *
 * Query params:
 *   limit    (default 50, max 200)
 *   offset   (default 0)
 *   status   (draft | confirmed | synced)
 *   po_id    (purchase_order.id)
 *   q        search bill #, Vendor PI/ref, PO, QB ref, vendor, receipt
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../purchase-orders/_lib/format";

// ── Zod query schema ──────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  po_id: z.string().optional(),
  bill_type: z.enum(["regular", "service", "freight", "tariff"]).optional(),
  q: z.string().trim().max(100).optional(),
});

const createVendorBillSchema = z.object({
  vendor_id: z.string().min(1),
  bill_type: z.enum(["regular", "service", "freight", "tariff"]).default("regular"),
  reference_id: z.string().max(200).nullish(),
  document_date: z.string().datetime().nullish(),
  commission_mode: z.enum(["percent", "fixed"]).default("percent"),
  notes: z.string().max(2000).nullish(),
});

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface VendorBillListRow {
  id: string;
  number: string | null;
  purchase_order_id: string | null;
  purchase_order_receipt_id: string | null;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  bill_type: string;
  reference_id: string | null;
  document_date: string | null;
  status: string;
  confirmed_at: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
  item_subtotal_cents: string | null;
  line_count: string; // bigint from COUNT — convert to number
  total_landed_cents: string | null; // bigint from SUM — convert to number
  billed_receipt_ids: string[] | null;
  po_number: string | null;
  po_qb_ref_number: string | null;
  receipt_number: string | null;
  vendor_name: string | null;
  created_at: string;
}

// ── GET handler ──────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { limit, offset, status, po_id, bill_type, q } = parsed.data;

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  // Build WHERE clauses — use ? (Knex binding placeholder, not pg $n)
  const whereClauses: string[] = [`vb.deleted_at IS NULL`];
  const bindings: unknown[] = [];

  if (status) {
    whereClauses.push(`vb.status = ?`);
    bindings.push(status);
  }
  if (po_id) {
    whereClauses.push(`vb.purchase_order_id = ?`);
    bindings.push(po_id);
  }
  if (bill_type) {
    whereClauses.push(`vb.bill_type = ?`);
    bindings.push(bill_type);
  }
  if (q) {
    const search = `%${q}%`;
    whereClauses.push(`(
      vb.number ILIKE ?
      OR vb.reference_id ILIKE ?
      OR vb.vendor_name_snapshot ILIKE ?
      OR po."number" ILIKE ?
      OR po.qb_purchase_order_txn_number ILIKE ?
      OR po.vendor_name_snapshot ILIKE ?
      OR por."number" ILIKE ?
    )`);
    bindings.push(search, search, search, search, search, search, search);
  }

  const whereStr = whereClauses.join(" AND ");

  // Count query
  const countResult = await knex.raw(
    `SELECT COUNT(*) AS total
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     WHERE ${whereStr}`,
    bindings
  );
  const count = Number((countResult.rows[0] as { total: string }).total);

  // Data query — LIMIT/OFFSET interpolated directly (validated numbers, safe)
  const dataResult = await knex.raw(
    `SELECT
       vb.id,
       vb.number,
       vb.purchase_order_id,
       vb.purchase_order_receipt_id,
       vb.vendor_id,
       vb.vendor_name_snapshot,
       vb.vendor_qb_list_id_snapshot,
       vb.bill_type,
       vb.reference_id,
       vb.document_date,
       vb.status,
       vb.confirmed_at,
       vb.commission_mode,
       vb.commission_rate_bps,
       vb.commission_amount_cents,
       vb.service_vendor_bill_id,
       vb.freight_vendor_bill_id,
       vb.tariff_vendor_bill_id,
       vb.freight_included,
       vb.freight_amount_cents,
       vb.tariff_included,
       vb.tariff_amount_cents,
       vb.created_at,
       COALESCE(agg.line_count, 0)         AS line_count,
       COALESCE(agg.item_subtotal_cents, 0) AS item_subtotal_cents,
       COALESCE(agg.total_landed_cents, 0) AS total_landed_cents,
       COALESCE(agg.billed_receipt_ids, ARRAY[]::text[]) AS billed_receipt_ids,
       po."number"                         AS po_number,
       po.qb_purchase_order_txn_number      AS po_qb_ref_number,
       por."number"                        AS receipt_number,
       COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot) AS vendor_name
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*)                                        AS line_count,
         SUM(vbl.unit_cost_cents * vbl.qty)              AS item_subtotal_cents,
         SUM(vbl.landed_unit_cost_cents * vbl.qty)       AS total_landed_cents,
         ARRAY_AGG(DISTINCT porl.purchase_order_receipt_id)
           FILTER (WHERE porl.purchase_order_receipt_id IS NOT NULL)
                                                        AS billed_receipt_ids
       FROM vendor_bill_line vbl
       LEFT JOIN purchase_order_receipt_line porl
         ON porl.id = vbl.receipt_line_id AND porl.deleted_at IS NULL
       WHERE vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
     ) agg ON TRUE
     WHERE ${whereStr}
     ORDER BY vb.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    bindings
  );

  const rows = (dataResult.rows as VendorBillListRow[]).map((r) => ({
    ...r,
    line_count: Number(r.line_count),
    item_subtotal_cents: Number(r.item_subtotal_cents ?? 0),
    total_landed_cents: Number(r.total_landed_cents ?? 0),
  }));

  return res.json({ vendor_bills: rows, count });
}

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

  const parsed = createVendorBillSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const body = parsed.data;
  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  const seqResult = await knex.raw(
    `SELECT nextval('custom_vendor_bill_seq') AS seq`
  );
  const vbNumber = `VB-${(seqResult.rows[0] as { seq: string | number }).seq}`;

  const vendorResult = await knex.raw(
    `SELECT id, qb_list_id, full_name, name, company_name
     FROM qb_vendor
     WHERE id = ? AND deleted_at IS NULL AND is_active = true
     LIMIT 1`,
    [body.vendor_id]
  );
  const vendor = (vendorResult.rows[0] ?? null) as
    | {
        id: string;
        qb_list_id: string | null;
        full_name: string | null;
        name: string | null;
        company_name: string | null;
      }
    | null;
  if (!vendor) {
    return res.status(422).json({
      error: "A valid active vendor must be selected",
      code: "vendor_required",
    });
  }
  const vendorName =
    vendor.company_name ?? vendor.full_name ?? vendor.name ?? vendor.id;

  const result = await knex.raw(
    `INSERT INTO vendor_bill (
       id,
       number,
       purchase_order_receipt_id,
       purchase_order_id,
       vendor_id,
       vendor_name_snapshot,
       vendor_qb_list_id_snapshot,
       bill_type,
       status,
       reference_id,
       document_date,
       commission_mode,
       commission_rate_bps,
       commission_amount_cents,
       freight_included,
       freight_amount_cents,
       tariff_included,
       tariff_amount_cents,
       notes,
       created_at,
       updated_at
     ) VALUES (
       ?,
       ?, NULL, NULL, ?, ?, ?, ?, 'draft', ?, COALESCE(?::timestamptz, NOW()), ?, 0, 0, false, 0, false, 0, ?, NOW(), NOW()
     )
     RETURNING *`,
    [
      `vb_${randomUUID().replace(/-/g, "")}`,
      vbNumber,
      vendor.id,
      vendorName,
      vendor.qb_list_id,
      body.bill_type,
      body.reference_id ?? null,
      body.document_date ?? null,
      body.commission_mode,
      body.notes ?? null,
    ]
  );

  return res.status(201).json({
    vendor_bill: {
      ...(result.rows[0] as Record<string, unknown>),
      lines: [],
      line_count: 0,
      total_landed_cents: 0,
      billed_receipt_ids: [],
    },
  });
}
