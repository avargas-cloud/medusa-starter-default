/**
 * Force-syncs POS Invoice 21015 (order 2571) line items to QuickBooks after
 * a manual SQL correction: the invoice had been snapshotted from a stale
 * cart (SKU EPS-SPR-D6024 @ $55.99) while the order (post-edit) has
 * EPS-SPR-D9024 @ $69.99. pos_invoice/pos_invoice_item were already
 * corrected via SQL to match the order; this replicates the EDIT path of
 * POST /admin/pos/sync (type=invoice) to enqueue the InvoiceMod pipeline
 * row so the running consolidator dispatches it to QB automatically.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/qb-mod-invoice-21015.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { buildInvoiceForceSyncActiveItems } from "../../lib/quickbooks/force-sync-doc-payload";
import { parseSalesRepInitials } from "../../lib/quickbooks/parse-sales-rep";
import {
  buildQbItems,
  buildShippingQbItem,
  getEffectiveOrderDiscount,
} from "../../lib/quickbooks/order-flow-core";
import { getQbConfig } from "../../lib/quickbooks/handlers/utils";
import { fetchInvoiceLinesFromQb } from "../../lib/quickbooks/client/invoices";
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";
import { INVOICE_MODULE } from "../../modules/invoices";

const INVOICE_ID = "01KX121Y1W13MQXV72NXDD45GS";

export default async function qbModInvoice21015({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const invoiceService: any = container.resolve(INVOICE_MODULE);

  const freshInvoice: any = await invoiceService.retrievePosInvoice(
    INVOICE_ID,
    { relations: ["items"] }
  );
  if (!freshInvoice) throw new Error("Invoice not found");

  const freshTxnId =
    freshInvoice.metadata?.qb_txn_id ||
    freshInvoice.metadata?.qb_ref_number ||
    freshInvoice.metadata?.qb_invoice_txn_id;
  if (!freshTxnId) throw new Error("Invoice has no qb_txn_id");

  const {
    data: [parentOrder],
  } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "metadata",
      "tax_total",
      "subtotal",
      "discount_total",
      "customer_id",
      "customer.*",
      "customer.metadata",
      "items.*",
      "items.variant.*",
      "items.variant.metadata",
      "shipping_methods.*",
    ],
    filters: { id: freshInvoice.order_id },
  });

  const salesRep = parseSalesRepInitials(parentOrder?.metadata?.sales_rep);

  const { activeItems, invoiceLineDiscountCents } =
    buildInvoiceForceSyncActiveItems(
      freshInvoice.items || [],
      parentOrder?.items || []
    );

  const missingQb = activeItems.filter(
    (i: any) => !i.variant?.metadata?.quickbooks_id
  );
  if (missingQb.length > 0) {
    console.warn(
      `⚠️ ${missingQb.length} item(s) lack quickbooks_id and will NOT sync: ${missingQb
        .map((i: any) => i.variant?.sku || i.title || i.id)
        .join(", ")}`
    );
  }

  const qbConfig = await getQbConfig();
  const qbItems = buildQbItems(activeItems, parentOrder?.metadata || {});

  const invoiceDiscount = Number(freshInvoice.discount);
  const discountTotal =
    Number.isFinite(invoiceDiscount) && invoiceDiscount > 0
      ? Math.max(0, invoiceDiscount - invoiceLineDiscountCents) / 100
      : getEffectiveOrderDiscount(parentOrder);
  if (discountTotal > 0) {
    throw new Error(
      `Unexpected discount on this invoice ($${discountTotal}) — script does not build discount lines, abort.`
    );
  }

  const shippingMethods =
    freshInvoice.shipping !== undefined && freshInvoice.shipping !== null
      ? Number(freshInvoice.shipping) > 0
        ? [{ name: "Shipping", amount: Number(freshInvoice.shipping) / 100 }]
        : []
      : parentOrder?.shipping_methods || [];
  const shippingItem = buildShippingQbItem(
    shippingMethods,
    qbConfig.shippingItemId
  );
  if (shippingItem) qbItems.push(shippingItem);

  const hasTax = parentOrder?.tax_total && parentOrder.tax_total > 0;
  const salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined;

  const snapshot = await fetchInvoiceLinesFromQb(freshTxnId);
  const availableLines = [...(snapshot?.lines || [])];
  console.log(`Pulled ${availableLines.length} existing QB line(s) from Invoice ${freshTxnId}`);

  for (const it of qbItems) {
    const targetId = (it as any).productId;
    const targetName = (it as any).productName;
    const qty = Number((it as any).quantity ?? 0);
    const amt = Number((it as any).amount ?? 0);
    const matchesItem = (l: any) =>
      (targetId && l.ItemListID === targetId) ||
      (!targetId && targetName && l.ItemFullName === targetName);
    const idxExact = availableLines.findIndex(
      (l) =>
        matchesItem(l) &&
        (qty === 0 || Math.abs((l.Quantity ?? 0) - qty) < 0.001) &&
        (amt === 0 || Math.abs((l.Amount ?? 0) - amt) < 0.01)
    );
    const idx = idxExact >= 0 ? idxExact : availableLines.findIndex(matchesItem);
    if (idx >= 0) {
      const matched = availableLines[idx];
      (it as any).TxnLineID = matched.TxnLineID;
      if (matched.hasSite === false) (it as any).noSite = true;
      availableLines.splice(idx, 1);
    } else {
      (it as any).TxnLineID = "-1";
    }
  }

  if (availableLines.length > 0) {
    console.log(
      `${availableLines.length} QB line(s) had no match and will be REMOVED: ${availableLines
        .map((l) => `${l.ItemFullName} (TxnLineID ${l.TxnLineID}, qty ${l.Quantity}, amt ${l.Amount})`)
        .join("; ")}`
    );
  }

  console.log("\nFinal qbItems to send:");
  for (const i of qbItems as any[]) {
    console.log(
      `  ${i.productName || i.productId} qty=${i.quantity ?? "-"} amount=${i.amount ?? "-"} TxnLineID=${i.TxnLineID}`
    );
  }

  const medusaRefNumber = freshInvoice.invoice_number
    ? `INV-${freshInvoice.invoice_number}`
    : null;

  const modPayload: any = {
    txnId: freshTxnId,
    items: qbItems,
    memo: freshInvoice.invoice_number
      ? `POS Invoice ${freshInvoice.invoice_number}`
      : undefined,
    ...(salesRep ? { salesRep } : {}),
    ...(salesTaxCode ? { salesTaxCode } : { taxExempt: true }),
  };

  await writePipelineRow({
    orderId: freshInvoice.order_id,
    referenceId: INVOICE_ID,
    referenceType: "pos_invoice",
    step: "invoice_update",
    status: "pending",
    qbTxnId: freshTxnId,
    medusaRefNumber,
    payload: modPayload,
  });

  console.log(
    `\n✅ Pipeline row enqueued (step=invoice_update, pending) for TxnID ${freshTxnId}. The running consolidator will dispatch it as an InvoiceMod within ~1 min.`
  );
}
