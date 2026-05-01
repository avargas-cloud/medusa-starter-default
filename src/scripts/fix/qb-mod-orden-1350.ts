/**
 * Sends an Invoice Mod to QuickBooks for QB ref 19472 (orden 1350) with
 * the corrected line items + Subtotal + Discount line.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/fix/qb-mod-orden-1350.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import { updateInvoiceInQb } from "../../lib/quickbooks/client/invoices";
import {
  buildQbOrderDiscountLines,
  buildQbItems,
} from "../../lib/quickbooks/order-flow-core";
import { getDbPool } from "../../api/utils/db-pool";

const INVOICE_ID = "01KQG8G8KESSWKWY1V2WKQ31BT";
const QB_TXN_ID = "1C254A-1777588578";

export default async function qbModOrden1350({
  container: _container,
}: {
  container: MedusaContainer;
}) {
  console.log(
    `\n📤 QB Invoice Mod for orden 1350 (QB ref 19472, TxnID ${QB_TXN_ID})\n`
  );

  const pool = getDbPool();

  // Read remaining pos_invoice_item rows (the 4 kept SKUs)
  const { rows: items } = await pool.query(
    `SELECT pii.sku, pii.description, pii.quantity, pii.unit_price/100.0 AS unit_price_dollars,
            pii.total/100.0 AS total_dollars, pii.variant_id, pv.metadata->>'quickbooks_id' AS qb_id
       FROM pos_invoice_item pii
       LEFT JOIN product_variant pv ON pv.id = pii.variant_id
      WHERE pii.invoice_id = $1 AND pii.deleted_at IS NULL
      ORDER BY pii.created_at`,
    [INVOICE_ID]
  );

  console.log(`pos_invoice_item rows: ${items.length}`);
  for (const it of items) {
    console.log(
      `  ${it.sku} qty=${it.quantity} unit=$${it.unit_price_dollars} total=$${it.total_dollars} qbId=${it.qb_id || "(none)"}`
    );
  }

  // Read invoice totals
  const { rows: invRows } = await pool.query(
    `SELECT subtotal/100.0 AS subtotal, discount/100.0 AS discount,
            total/100.0 AS total
       FROM pos_invoice WHERE id = $1`,
    [INVOICE_ID]
  );
  const inv = invRows[0];
  console.log(
    `\nTotals: subtotal=$${inv.subtotal}, discount=$${inv.discount}, total=$${inv.total}`
  );

  // Build prebuiltItems for QB
  const itemsAtList = items.map((it: any) => ({
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price_dollars),
    subtotal: Number(it.total_dollars),
    title: it.description,
    variant: { sku: it.sku, metadata: { quickbooks_id: it.qb_id } },
  }));

  const prebuiltItems = buildQbItems(itemsAtList, {});

  // Compute list subtotal for discount percentage display
  const listSubtotal = items.reduce(
    (s: number, it: any) => s + Number(it.total_dollars),
    0
  );
  const discountPct = listSubtotal > 0 ? (Number(inv.discount) / listSubtotal) * 100 : null;

  buildQbOrderDiscountLines(Number(inv.discount), discountPct).forEach(
    (l: any) => prebuiltItems.push(l)
  );

  console.log(`\nPrebuilt items for QB Mod (${prebuiltItems.length} lines):`);
  for (const i of prebuiltItems) {
    console.log(
      `  ${i.productName || i.productId} qty=${i.quantity ?? "-"} price=${i.price ?? "-"} desc=${(i.desc || "").substring(0, 50)}`
    );
  }

  console.log(`\n🚀 Calling updateInvoiceInQb on TxnID ${QB_TXN_ID}...`);
  const result = await updateInvoiceInQb({
    txnId: QB_TXN_ID,
    items: prebuiltItems as any,
  });

  console.log(`\nResult: ${JSON.stringify(result, null, 2)}`);

  if (result.success) {
    console.log("\n✅ QB Invoice Mod sent successfully.");
    // Update pipeline row to confirmed
    await pool.query(
      `UPDATE qb_order_pipeline
          SET status = 'confirmed',
              bridge_op_id = $2,
              confirmed_at = NOW(),
              updated_at = NOW()
        WHERE order_id = $1 AND step = 'invoice_update' AND status = 'pending'`,
      ["order_01KP64PS82JB844N64TFJEWA0X", result.data?.operationId ?? null]
    );
    console.log("   Pipeline row marked confirmed.");
  } else {
    console.log(`\n❌ QB Invoice Mod failed: ${result.error}`);
    process.exitCode = 1;
  }
}
