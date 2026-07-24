/**
 * smoke-qb-bill-match-by-vendor.ts — READ-ONLY validation of the bill-first
 * (candidates-by-vendor) path against the REAL QB bridge. Mirrors the route:
 * resolve vendor → unbilled POs → 2-month window → one BillQuery → classify.
 * Writes NOTHING.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/debug/smoke-qb-bill-match-by-vendor.ts "luxury led"
 */

import { Client } from "pg";
import { queryVendorBills } from "../../api/admin/quickbooks/bill-match/_lib/bill-query";

function fmtUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const nameArg = process.argv[2] ?? "luxury led";
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows: vRows } = await client.query<{ id: string; name: string | null; company_name: string | null; qb_list_id: string | null }>(
      `SELECT id, name, company_name, qb_list_id FROM qb_vendor
        WHERE deleted_at IS NULL AND qb_list_id IS NOT NULL
          AND (name ILIKE $1 OR company_name ILIKE $1) ORDER BY name LIMIT 1`,
      [`%${nameArg}%`]
    );
    const vendor = vRows[0];
    if (!vendor) throw new Error(`vendor matching "${nameArg}" not found`);

    // Unbilled POs (not-fully-billed) for this vendor.
    const { rows: poRows } = await client.query<{ id: string; number: string | null; created_at: string }>(
      `SELECT p.id, p.number, p.created_at
         FROM purchase_order p
        WHERE p.deleted_at IS NULL AND p.vendor_id = $1
          AND p.status IN ('submitted','partially_received','received')
          AND NOT EXISTS (SELECT 1 FROM vendor_bill vb WHERE vb.purchase_order_id=p.id AND vb.bill_type='regular' AND vb.status IN ('confirmed','synced') AND vb.deleted_at IS NULL)
        ORDER BY p.created_at ASC`,
      [vendor.id]
    );

    const oldest = poRows.length ? new Date(poRows[0].created_at) : new Date();
    const monthsBack = poRows.length ? 2 : 4;
    const from = fmtUtc(new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth() - monthsBack, oldest.getUTCDate())));
    const to = fmtUtc(new Date());

    console.log(`Vendor: ${vendor.company_name || vendor.name} (ListID ${vendor.qb_list_id})`);
    console.log(`Unbilled POs: ${poRows.length}${poRows.length ? ` (oldest ${poRows[0].number} @ ${fmtUtc(new Date(poRows[0].created_at))})` : ""}`);
    console.log(`Window: ${from} → ${to}  (${monthsBack} months before oldest PO)`);
    console.log(`Querying QuickBooks…\n`);

    const bills = await queryVendorBills({ vendorListId: vendor.qb_list_id, fromDate: from, toDate: to });
    const txnIds = bills.map((b) => b.txn_id).filter(Boolean);
    const recorded = new Set<string>();
    if (txnIds.length) {
      const { rows } = await client.query<{ qb_txn_id: string }>(
        `SELECT qb_txn_id FROM vendor_bill WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`, [txnIds]);
      for (const r of rows) recorded.add(r.qb_txn_id);
    }

    let adoptable = 0, linked = 0, rec = 0;
    for (const b of bills) {
      const alreadyRecorded = recorded.has(b.txn_id);
      const qbLinked = b.linked_txns.some((l) => l.txn_type === "PurchaseOrder" || l.txn_type === "ItemReceipt") || b.item_lines.some((il) => !!il.linked_txn_id);
      const isAdoptable = !alreadyRecorded && !qbLinked;
      if (alreadyRecorded) rec++; else if (qbLinked) linked++; else adoptable++;
      const tag = alreadyRecorded ? "RECORDED" : qbLinked ? "linked-in-QB" : "★ ADOPTABLE";
      console.log(`  ${b.txn_date}  ref=${b.ref_number || "-"}  $${(b.total_cents/100).toFixed(2)}  items=${b.item_lines.length}  ${tag}`);
    }
    console.log(`\n=== ${bills.length} bills · ★ ${adoptable} ADOPTABLE · ${linked} linked-in-QB · ${rec} already recorded ===`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((e) => { console.error("SMOKE FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
