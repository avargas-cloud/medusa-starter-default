import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { deriveBilledStatus } from "../../../purchase-orders/_lib/billed-status";

/**
 * GET /admin/quickbooks/bill-match/unbilled-pos
 *
 * The PO-first work queue for the "Match QB Bills" page: POs that are not fully
 * billed (no regular confirmed/synced bill, or billed qty < received), grouped
 * by vendor. Agency (China-agent) vendors are flagged — Full match is Phase 2
 * for them, only ⚡ Adopt is offered.
 */
interface PoQueueRow {
  id: string;
  number: string | null;
  created_at: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  qb_purchase_order_list_id: string | null;
  is_agency: boolean;
  total_cents: number;
  received_units: number;
  billable_ordered_units: number;
  billed_qty: number;
  has_adopted_zero_line: boolean;
}

interface QueuePo {
  po_id: string;
  number: string | null;
  doc_date: string;
  total_cents: number;
  received_units: number;
  billed_qty: number;
  billed_status: "no" | "partial" | "yes";
  has_qb_txnid: boolean;
}

interface QueueVendor {
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_qb_list_id: string | null;
  is_agency: boolean;
  pos: QueuePo[];
}

export async function GET(_req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query<PoQueueRow>(
      `WITH po AS (
         SELECT p.id, p.number, p.created_at, p.vendor_id, p.vendor_name_snapshot,
                p.vendor_qb_list_id_snapshot, p.qb_purchase_order_list_id,
                COALESCE((qv.metadata->>'is_china_agent') = 'true', false) AS is_agency
           FROM purchase_order p
           LEFT JOIN qb_vendor qv ON qv.id = p.vendor_id AND qv.deleted_at IS NULL
          WHERE p.deleted_at IS NULL
            AND p.status IN ('submitted','partially_received','received')
       ),
       line_agg AS (
         SELECT pol.purchase_order_id AS po_id,
                COALESCE(SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) * pol.unit_cost_cents),0) AS total_cents,
                COALESCE(SUM(COALESCE(pol.qty_received,0)),0) AS received_units,
                -- Same subtraction resolveRemainingPoQuantities uses, so a PO
                -- cannot read fully billed here and still be offered as billable.
                COALESCE(SUM(
                  CASE WHEN COALESCE(pol.status,'open') <> 'cancelled'
                       THEN GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0)
                       ELSE 0 END
                ),0) AS billable_ordered_units
           FROM purchase_order_line pol
          WHERE pol.deleted_at IS NULL
          GROUP BY pol.purchase_order_id
       ),
       bill_agg AS (
         SELECT vb.purchase_order_id AS po_id,
                COALESCE(SUM(CASE WHEN COALESCE(vbl.line_type,'product')='product' THEN vbl.qty ELSE 0 END),0) AS billed_qty,
                BOOL_OR(vb.qb_source='adopted' AND vbl.id IS NULL) AS has_adopted_zero_line
           FROM vendor_bill vb
           LEFT JOIN vendor_bill_line vbl
                  ON vbl.vendor_bill_id = vb.id
                 AND vbl.deleted_at IS NULL
                 AND COALESCE(vbl.line_type,'product')='product'
          WHERE vb.bill_type='regular'
            AND vb.status IN ('confirmed','synced')
            AND vb.deleted_at IS NULL
          GROUP BY vb.purchase_order_id
       )
       SELECT po.id, po.number, po.created_at, po.vendor_id, po.vendor_name_snapshot,
              po.vendor_qb_list_id_snapshot, po.qb_purchase_order_list_id, po.is_agency,
              COALESCE(la.total_cents,0)::float AS total_cents,
              COALESCE(la.received_units,0)::int AS received_units,
              COALESCE(la.billable_ordered_units,0)::int AS billable_ordered_units,
              COALESCE(ba.billed_qty,0)::int AS billed_qty,
              COALESCE(ba.has_adopted_zero_line,false) AS has_adopted_zero_line
         FROM po
         LEFT JOIN line_agg la ON la.po_id = po.id
         LEFT JOIN bill_agg ba ON ba.po_id = po.id
        ORDER BY po.created_at ASC`
    );

    const byVendor = new Map<string, QueueVendor>();
    for (const r of rows) {
      const billed = deriveBilledStatus({
        billedQty: Number(r.billed_qty),
        hasAdoptedZeroLineBill: Boolean(r.has_adopted_zero_line),
        billableOrderedQty: Number(r.billable_ordered_units),
      });
      if (billed.billed_status === "yes") continue; // fully billed — not actionable

      const key = r.vendor_id ?? "__no_vendor__";
      let vendor = byVendor.get(key);
      if (!vendor) {
        vendor = {
          vendor_id: r.vendor_id,
          vendor_name: r.vendor_name_snapshot,
          vendor_qb_list_id: r.vendor_qb_list_id_snapshot,
          is_agency: Boolean(r.is_agency),
          pos: [],
        };
        byVendor.set(key, vendor);
      }
      vendor.pos.push({
        po_id: r.id,
        number: r.number,
        doc_date: r.created_at,
        total_cents: Math.round(Number(r.total_cents)),
        received_units: Number(r.received_units),
        billed_qty: Number(r.billed_qty),
        billed_status: billed.billed_status,
        has_qb_txnid: Boolean(r.qb_purchase_order_list_id),
      });
    }

    const vendors = [...byVendor.values()].sort(
      (a, b) => (b.pos.length - a.pos.length) || String(a.vendor_name).localeCompare(String(b.vendor_name))
    );
    res.json({ success: true, vendors });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to load unbilled POs";
    console.error("[QB Bill Match unbilled-pos] Error:", error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
