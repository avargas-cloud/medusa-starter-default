import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { deriveBilledStatus } from "../../../purchase-orders/_lib/billed-status";
import { queryVendorBills } from "../_lib/bill-query";

/**
 * GET /admin/quickbooks/bill-match/candidates-by-vendor?vendor_id=&from=&to=
 *
 * Bill-first flow: ONE QuickBooks BillQuery for a whole vendor (instead of one
 * per PO), plus the vendor's not-fully-billed POs so the operator can map each
 * adoptable bill to the right PO in a single pass. The date window defaults to
 * (oldest unbilled PO − 2 months → today) so a bill entered before its PO date
 * (deposit/prepay) is still caught; for a vendor with no unbilled POs (e.g. a
 * future service bill) it defaults to the last 4 months. Both are overridable.
 *
 * Each bill is flagged: already_recorded_local (its TxnID is already a local
 * vendor_bill) and qb_linked (it already links to a PO/receipt inside QB). The
 * "adoptable" set is those that are neither.
 */
interface UnbilledPoRow {
  id: string;
  number: string | null;
  created_at: string;
  qb_purchase_order_list_id: string | null;
  total_cents: number;
  received_units: number;
  billed_qty: number;
  has_adopted_zero_line: boolean;
}

function fmtUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const vendorId = String((req.query.vendor_id as string) ?? "").trim();
  if (!vendorId) {
    res.status(400).json({ error: "vendor_id is required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // ── Vendor + QB ListID ──
    const { rows: vRows } = await client.query<{
      id: string;
      name: string | null;
      company_name: string | null;
      qb_list_id: string | null;
      is_agency: boolean;
    }>(
      `SELECT id, name, company_name, qb_list_id,
              COALESCE((metadata->>'is_china_agent') = 'true', false) AS is_agency
         FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL`,
      [vendorId]
    );
    const vendor = vRows[0];
    if (!vendor) {
      res.status(404).json({ error: `Vendor ${vendorId} not found` });
      return;
    }
    if (!vendor.qb_list_id) {
      res.status(400).json({ error: "Vendor is not linked to a QuickBooks vendor (no ListID)" });
      return;
    }

    // ── Vendor's not-fully-billed POs (the mapping targets) ──
    const { rows: poRows } = await client.query<UnbilledPoRow>(
      `WITH po AS (
         SELECT p.id, p.number, p.created_at, p.qb_purchase_order_list_id
           FROM purchase_order p
          WHERE p.deleted_at IS NULL
            AND p.vendor_id = $1
            AND p.status IN ('submitted','partially_received','received')
       ),
       line_agg AS (
         SELECT pol.purchase_order_id AS po_id,
                COALESCE(SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) * pol.unit_cost_cents),0) AS total_cents,
                COALESCE(SUM(COALESCE(pol.qty_received,0)),0) AS received_units
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
                  ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
                 AND COALESCE(vbl.line_type,'product')='product'
          WHERE vb.bill_type='regular' AND vb.status IN ('confirmed','synced') AND vb.deleted_at IS NULL
          GROUP BY vb.purchase_order_id
       )
       SELECT po.id, po.number, po.created_at, po.qb_purchase_order_list_id,
              COALESCE(la.total_cents,0)::float AS total_cents,
              COALESCE(la.received_units,0)::int AS received_units,
              COALESCE(ba.billed_qty,0)::int AS billed_qty,
              COALESCE(ba.has_adopted_zero_line,false) AS has_adopted_zero_line
         FROM po
         LEFT JOIN line_agg la ON la.po_id = po.id
         LEFT JOIN bill_agg ba ON ba.po_id = po.id
        ORDER BY po.created_at ASC`,
      [vendorId]
    );

    const unbilledPos = poRows
      .filter(
        (r) =>
          deriveBilledStatus({
            billedQty: Number(r.billed_qty),
            hasAdoptedZeroLineBill: Boolean(r.has_adopted_zero_line),
            totalUnitsReceived: Number(r.received_units),
          }).billed_status !== "yes"
      )
      .map((r) => ({
        po_id: r.id,
        number: r.number,
        doc_date: r.created_at,
        total_cents: Math.round(Number(r.total_cents)),
        received_units: Number(r.received_units),
        has_qb_txnid: Boolean(r.qb_purchase_order_list_id),
      }));

    // ── Date window: 2 calendar months before the oldest unbilled PO → today ──
    const oldest = unbilledPos.reduce<number | null>((min, p) => {
      const t = new Date(p.doc_date).getTime();
      return min === null || t < min ? t : min;
    }, null);
    const anchor = new Date(oldest ?? Date.now());
    // No unbilled POs (service vendor): fall back to a 4-month lookback from today.
    const monthsBack = oldest !== null ? 2 : 4;
    const defFromMs = Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() - monthsBack,
      anchor.getUTCDate()
    );
    const fromDate = String((req.query.from as string) ?? "").trim() || fmtUtc(new Date(defFromMs));
    const toDate = String((req.query.to as string) ?? "").trim() || fmtUtc(new Date());

    // ── One BillQuery for the whole vendor ──
    const bills = await queryVendorBills({ vendorListId: vendor.qb_list_id, fromDate, toDate });

    const txnIds = bills.map((b) => b.txn_id).filter(Boolean);
    const recordedSet = new Set<string>();
    if (txnIds.length > 0) {
      const { rows: rec } = await client.query<{ qb_txn_id: string }>(
        `SELECT qb_txn_id FROM vendor_bill WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`,
        [txnIds]
      );
      for (const r of rec) recordedSet.add(r.qb_txn_id);
    }

    const billOut = bills.map((b) => {
      const alreadyRecorded = recordedSet.has(b.txn_id);
      // qb_linked is an informational CAUTION, not an exclusion: a bill can be
      // linked in QB to a PurchaseOrder whose TxnID does NOT match our PO's
      // recorded qb_purchase_order_list_id (TxnID drift — the exact reason the
      // automatic reconcile misses it, e.g. PO-1012's bill 6193 links to
      // ...705 while store-pos has ...785). Those are precisely the bills the
      // operator must resolve by eye, so adoptable is driven ONLY by "not
      // already recorded locally".
      const qbLinked =
        b.linked_txns.some((l) => l.txn_type === "PurchaseOrder" || l.txn_type === "ItemReceipt") ||
        b.item_lines.some((il) => Boolean(il.linked_txn_id));
      return {
        txn_id: b.txn_id,
        ref_number: b.ref_number,
        txn_date: b.txn_date,
        memo: b.memo,
        amount_due_cents: b.amount_due_cents,
        total_cents: b.total_cents,
        item_line_count: b.item_lines.length,
        expense_line_count: b.expense_lines.length,
        item_preview: b.item_lines.slice(0, 8).map((l) => ({
          name: l.item_full_name,
          qty: l.quantity,
          amount_cents: l.amount_cents,
        })),
        already_recorded_local: alreadyRecorded,
        qb_linked: qbLinked,
        adoptable: !alreadyRecorded,
      };
    });

    res.json({
      success: true,
      vendor: {
        id: vendor.id,
        name: vendor.company_name || vendor.name,
        qb_list_id: vendor.qb_list_id,
        is_agency: vendor.is_agency,
      },
      window: { from: fromDate, to: toDate },
      unbilled_pos: unbilledPos,
      bills: billOut,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to query vendor bill candidates";
    console.error(`[QB Bill Match candidates-by-vendor ${vendorId}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
