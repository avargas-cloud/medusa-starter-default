/**
 * src/api/admin/vendor-bills/billable-receipts/route.ts
 *
 * GET /admin/vendor-bills/billable-receipts
 *
 * Powers the "From Item Receipts" creation flow (D6/D8,
 * docs/VENDOR_BILL_QB_SYNC_PLAN.md): lists `applied`/`synced` receipts that
 * are NOT yet bound to any vendor bill, newest first. Dual-read against both
 * the D6 per-receipt FK (`purchase_order_receipt.vendor_bill_id`) and the
 * legacy `vendor_bill.purchase_order_receipt_id` mirror — same rule
 * `validateReceiptsForBinding` enforces at bind time — so a receipt already
 * billed via either path never shows up as billable here.
 *
 * Query params:
 *   search         optional — matches receipt #, PO #, or vendor name (ILIKE)
 *   include_bound  optional ("1"/"true") — ALSO return receipts already bound
 *                  to a bill, each carrying `bound_to: {bill_id, number}`. The
 *                  unified hierarchical fill modal renders these as disabled
 *                  rows ("already on VB-####") so the operator sees the whole
 *                  picture per PO instead of receipts silently missing.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../purchase-orders/_lib/format";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

const querySchema = z.object({
  search: z.string().trim().max(100).optional(),
  include_bound: z.enum(["1", "true"]).optional(),
});

interface BillableReceiptRow {
  id: string;
  number: string;
  seq: number;
  received_at: string;
  units: number;
  purchase_order_id: string;
  po_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  bound_bill_id: string | null;
  bound_bill_number: string | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { search, include_bound } = parsed.data;
  const includeBound = include_bound === "1" || include_bound === "true";

  const knex = resolveKnex(req);

  const whereClauses: string[] = [
    `por.status IN ('applied', 'synced')`,
    `por.deleted_at IS NULL`,
  ];
  if (!includeBound) {
    // Dual-read "unbound" — mirrors validateReceiptsForBinding's own check:
    // neither the new per-receipt FK nor the legacy bill pointer may claim it.
    whereClauses.push(
      `por.vendor_bill_id IS NULL`,
      `NOT EXISTS (
         SELECT 1 FROM vendor_bill legacy_vb
          WHERE legacy_vb.purchase_order_receipt_id = por.id
            AND legacy_vb.deleted_at IS NULL
       )`
    );
  }
  const bindings: unknown[] = [];

  if (search) {
    const term = `%${search}%`;
    whereClauses.push(
      `(por.number ILIKE ? OR po.number ILIKE ? OR po.vendor_name_snapshot ILIKE ?)`
    );
    bindings.push(term, term, term);
  }

  const whereStr = whereClauses.join(" AND ");

  const result = await knex.raw(
    `SELECT
       por.id,
       por.number,
       por.seq,
       por.received_at,
       COALESCE(SUM(porl.qty_received_now), 0)::int AS units,
       po.id     AS purchase_order_id,
       po.number AS po_number,
       po.vendor_id AS vendor_id,
       po.vendor_name_snapshot AS vendor_name,
       bound_vb.id AS bound_bill_id,
       bound_vb.number AS bound_bill_number
     FROM purchase_order_receipt por
     JOIN purchase_order po
       ON po.id = por.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt_line porl
       ON porl.purchase_order_receipt_id = por.id AND porl.deleted_at IS NULL
     LEFT JOIN vendor_bill bound_vb
       ON bound_vb.deleted_at IS NULL
      AND (bound_vb.id = por.vendor_bill_id
           OR bound_vb.purchase_order_receipt_id = por.id)
     WHERE ${whereStr}
     GROUP BY por.id, por.number, por.seq, por.received_at,
              po.id, po.number, po.vendor_id, po.vendor_name_snapshot,
              bound_vb.id, bound_vb.number
     ORDER BY por.received_at DESC, por.seq DESC
     LIMIT 100`,
    bindings
  );

  const rows = (result.rows as BillableReceiptRow[]).map((r) => ({
    id: r.id,
    number: r.number,
    seq: r.seq,
    received_at: r.received_at,
    units: Number(r.units),
    purchase_order_id: r.purchase_order_id,
    po_number: r.po_number,
    vendor_id: r.vendor_id,
    vendor_name: r.vendor_name,
    bound_to: r.bound_bill_id
      ? { bill_id: r.bound_bill_id, number: r.bound_bill_number }
      : null,
  }));

  return res.json({ receipts: rows });
}
