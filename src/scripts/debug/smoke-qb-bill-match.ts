/**
 * smoke-qb-bill-match.ts — READ-ONLY validation of the QB Bill Match query path
 * against the REAL QuickBooks bridge. Runs a bounded BillQuery for a PO's vendor
 * window, parses it, and classifies each candidate exactly as the candidates
 * route does. Writes NOTHING (no adopt). Sanctioned by the qb-query skill.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/debug/smoke-qb-bill-match.ts [PO-1123]
 */

import { Client } from "pg";

import { queryVendorBills } from "../../api/admin/quickbooks/bill-match/_lib/bill-query";
import { classifyMismatch, classifyQbLinkState } from "../../api/admin/quickbooks/bill-match/_lib/classify";

function fmtUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "PO-1123";
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string; number: string | null; created_at: string;
      qb_purchase_order_list_id: string | null; vendor_qb_list_id_snapshot: string | null;
      vendor_name_snapshot: string | null; total_cents: number | null;
    }>(
      `SELECT p.id, p.number, p.created_at, p.qb_purchase_order_list_id, p.vendor_qb_list_id_snapshot,
              p.vendor_name_snapshot,
              (SELECT COALESCE(SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0)*pol.unit_cost_cents),0)
                 FROM purchase_order_line pol WHERE pol.purchase_order_id=p.id AND pol.deleted_at IS NULL) AS total_cents
         FROM purchase_order p WHERE (p.number=$1 OR p.id=$1) AND p.deleted_at IS NULL LIMIT 1`,
      [arg]
    );
    const po = rows[0];
    if (!po) throw new Error(`PO ${arg} not found`);
    const vendorListId = po.vendor_qb_list_id_snapshot ?? "";
    if (!vendorListId) throw new Error(`PO ${arg} vendor has no QB ListID`);

    const from = fmtUtc(new Date(new Date(po.created_at).getTime() - 30 * 86_400_000));
    const to = fmtUtc(new Date());
    const { rows: recRows } = await client.query<{ qb_item_receipt_list_id: string | null }>(
      `SELECT qb_item_receipt_list_id FROM purchase_order_receipt WHERE purchase_order_id=$1 AND deleted_at IS NULL AND qb_item_receipt_list_id IS NOT NULL`,
      [po.id]
    );
    const receiptQbIds = recRows.map((r) => r.qb_item_receipt_list_id!).filter(Boolean);
    const poRef = Math.round(Number(po.total_cents ?? 0));

    console.log(`PO ${po.number} — ${po.vendor_name_snapshot} (ListID ${vendorListId})`);
    console.log(`Window ${from} → ${to} · PO value $${(poRef / 100).toFixed(2)}`);
    console.log("Querying QuickBooks (read-only BillQuery)…\n");

    const bills = await queryVendorBills({ vendorListId, fromDate: from, toDate: to });
    console.log(`${bills.length} bill(s) returned for this vendor in the window:\n`);
    for (const b of bills) {
      const linkState = classifyQbLinkState({ bill: b, poQbTxnId: po.qb_purchase_order_list_id, receiptQbIds });
      const mm = classifyMismatch({
        vendorMatches: b.vendor_list_id === vendorListId,
        alreadyAdoptedLocal: false,
        qbLinkState: linkState,
        billTotalCents: b.total_cents,
        poReferenceCents: poRef,
      });
      console.log(
        `  ${b.txn_date}  ref=${b.ref_number || "-"}  total=$${(b.total_cents / 100).toFixed(2)}  ` +
          `due=$${(b.amount_due_cents / 100).toFixed(2)}  items=${b.item_lines.length} exp=${b.expense_lines.length}  ` +
          `link=${linkState}  band=${mm.band}`
      );
      if (mm.reasons.length) console.log(`      ${mm.reasons.join(" | ")}`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
