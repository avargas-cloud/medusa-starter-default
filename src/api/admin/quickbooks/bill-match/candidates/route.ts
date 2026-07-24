import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { queryVendorBills } from "../_lib/bill-query";
import { classifyMismatch, classifyQbLinkState } from "../_lib/classify";

/**
 * GET /admin/quickbooks/bill-match/candidates?po_id=&from=&to=
 *
 * Runs a bounded QB BillQuery over a date window (default: PO creation − 30d →
 * today, operator-overridable via from/to), filters to the PO's vendor, and
 * classifies each bill for the operator's manual match: what it's already
 * linked to in QB, whether we already recorded it locally, and a mismatch band.
 */
function fmtUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const poId = String((req.query.po_id as string) ?? "").trim();
  if (!poId) {
    res.status(400).json({ error: "po_id is required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    const { rows: poRows } = await client.query<{
      id: string;
      number: string | null;
      created_at: string;
      qb_purchase_order_list_id: string | null;
      vendor_qb_list_id_snapshot: string | null;
      total_cents: number | null;
    }>(
      `SELECT p.id, p.number, p.created_at, p.qb_purchase_order_list_id, p.vendor_qb_list_id_snapshot,
              (SELECT COALESCE(SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) * pol.unit_cost_cents),0)
                 FROM purchase_order_line pol
                WHERE pol.purchase_order_id = p.id AND pol.deleted_at IS NULL) AS total_cents
         FROM purchase_order p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [poId]
    );
    const po = poRows[0];
    if (!po) {
      res.status(404).json({ error: `Purchase order ${poId} not found` });
      return;
    }
    const vendorListId = po.vendor_qb_list_id_snapshot ?? "";
    if (!vendorListId) {
      res.status(400).json({ error: "PO vendor is not linked to a QuickBooks vendor (no ListID)" });
      return;
    }

    // Date window: default = PO created − 30d → today (UTC). Operator can widen.
    const created = new Date(po.created_at);
    const defFrom = new Date(created.getTime() - 30 * 86_400_000);
    const fromDate = String((req.query.from as string) ?? "").trim() || fmtUtc(defFrom);
    const toDate = String((req.query.to as string) ?? "").trim() || fmtUtc(new Date());

    // PO's receipt QB TxnIDs (to recognize a bill already linked to this PO's receipts).
    const { rows: receiptRows } = await client.query<{ qb_item_receipt_list_id: string | null }>(
      `SELECT qb_item_receipt_list_id FROM purchase_order_receipt
        WHERE purchase_order_id = $1 AND deleted_at IS NULL AND qb_item_receipt_list_id IS NOT NULL`,
      [poId]
    );
    const receiptQbIds = receiptRows.map((r) => r.qb_item_receipt_list_id!).filter(Boolean);

    const bills = await queryVendorBills({ vendorListId, fromDate, toDate });

    // Which of these TxnIDs are already recorded locally (owned or adopted)?
    const txnIds = bills.map((b) => b.txn_id).filter(Boolean);
    const adoptedSet = new Set<string>();
    if (txnIds.length > 0) {
      const { rows: adoptedRows } = await client.query<{ qb_txn_id: string }>(
        `SELECT qb_txn_id FROM vendor_bill
          WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`,
        [txnIds]
      );
      for (const r of adoptedRows) adoptedSet.add(r.qb_txn_id);
    }

    const poReferenceCents = Math.round(Number(po.total_cents ?? 0));
    const candidates = bills.map((bill) => {
      const qbLinkState = classifyQbLinkState({
        bill,
        poQbTxnId: po.qb_purchase_order_list_id,
        receiptQbIds,
      });
      const alreadyAdoptedLocal = adoptedSet.has(bill.txn_id);
      const mismatch = classifyMismatch({
        vendorMatches: bill.vendor_list_id === vendorListId,
        alreadyAdoptedLocal,
        qbLinkState,
        billTotalCents: bill.total_cents,
        poReferenceCents,
      });
      return {
        txn_id: bill.txn_id,
        ref_number: bill.ref_number,
        txn_date: bill.txn_date,
        memo: bill.memo,
        amount_due_cents: bill.amount_due_cents,
        total_cents: bill.total_cents,
        item_line_count: bill.item_lines.length,
        expense_line_count: bill.expense_lines.length,
        item_preview: bill.item_lines.slice(0, 8).map((l) => ({
          name: l.item_full_name,
          qty: l.quantity,
          amount_cents: l.amount_cents,
        })),
        qb_link_state: qbLinkState,
        already_adopted_local: alreadyAdoptedLocal,
        mismatch,
      };
    });

    res.json({
      success: true,
      po: { id: po.id, number: po.number, total_cents: poReferenceCents },
      window: { from: fromDate, to: toDate },
      vendor_qb_list_id: vendorListId,
      candidates,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to query QB bill candidates";
    console.error(`[QB Bill Match candidates po=${poId}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
