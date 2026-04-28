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
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../purchase-orders/_lib/format";

// ── Zod query schema ──────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  po_id: z.string().optional(),
});

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface VendorBillListRow {
  id: string;
  number: string | null;
  purchase_order_id: string;
  purchase_order_receipt_id: string;
  status: string;
  confirmed_at: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
  line_count: string; // bigint from COUNT — convert to number
  total_landed_cents: string | null; // bigint from SUM — convert to number
  po_number: string | null;
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
  const { limit, offset, status, po_id } = parsed.data;

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

  const whereStr = whereClauses.join(" AND ");

  // Count query
  const countResult = await knex.raw(
    `SELECT COUNT(*) AS total FROM vendor_bill vb WHERE ${whereStr}`,
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
       vb.status,
       vb.confirmed_at,
       vb.commission_mode,
       vb.commission_rate_bps,
       vb.commission_amount_cents,
       vb.freight_included,
       vb.freight_amount_cents,
       vb.tariff_included,
       vb.tariff_amount_cents,
       vb.created_at,
       COALESCE(agg.line_count, 0)         AS line_count,
       COALESCE(agg.total_landed_cents, 0) AS total_landed_cents,
       po."number"                         AS po_number,
       por."number"                        AS receipt_number,
       po.vendor_name_snapshot              AS vendor_name
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*)                                        AS line_count,
         SUM(vbl.landed_unit_cost_cents * vbl.qty)       AS total_landed_cents
       FROM vendor_bill_line vbl
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
    total_landed_cents: Number(r.total_landed_cents ?? 0),
  }));

  return res.json({ vendor_bills: rows, count });
}
