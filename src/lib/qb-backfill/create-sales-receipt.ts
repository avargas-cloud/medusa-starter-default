/**
 * src/lib/qb-backfill/create-sales-receipt.ts
 *
 * Sales Receipt de QB → en el POS es una `pos_invoice` con
 * `metadata.is_sales_receipt = true`, PAGADA, con el pago EMBEBIDO:
 * `customer_payment` (marcado `qb_source: 'sales_receipt'`,
 * `qb_txn_id: 'SYNCED_VIA_RECEIPT'` — así ningún handler le busca un
 * ReceivePayment propio en QB) + `payment_application` + `invoice_payment`.
 * Molde: `scripts/sync/backfill-qb-sales-receipt-27925.ts`.
 *
 * Pipeline: `customer` skipped · `sales_order` skipped ("superseded by
 * Sales Receipt") · `sales_receipt` confirmed con `reference_type =
 * 'pos_invoice'` y `medusa_ref_number = 'SR-<invoice_number>'`, igual que
 * el flujo nativo.
 */
import { businessInstant } from "./create-po";
import { backdateOrder, createSalesOrderAndInvoice, requireCustomer, resolveProductLines, type SalesCreateResult } from "./create-sales-invoice";
import { planSalesLines } from "./sales-lines";
import { mapQbPaymentMethod } from "./sales-derive";
import { allocatePaymentDisplayId } from "./sales-numbering";
import { BACKFILL_ACTOR, backdateRows, firstId, seedPipelineRow, type SalesApplyContext } from "./sales-context";
import type { QbSalesReceipt } from "./sales-types";

export async function createSalesReceiptFromQb(ctx: SalesApplyContext, sr: QbSalesReceipt): Promise<SalesCreateResult> {
  const plan = planSalesLines(sr.lines, ctx.itemIndex, sr.sales_tax_total_cents, sr.total_amount_cents);
  if (!plan.ok) return { ok: false, reason: plan.reason, detail: { ...plan } };
  const customerRef = requireCustomer(sr);
  const pm = mapQbPaymentMethod(sr.payment_method_ref?.full_name);
  const lines = await resolveProductLines(ctx, plan.lines);
  const total = plan.totals.total_cents;
  const at = businessInstant(sr.txn_date);

  const ids = await createSalesOrderAndInvoice(ctx, {
    header: { ...sr, txn_type: "SalesReceipt", customer_ref: customerRef },
    lines,
    totals: plan.totals,
    status: "paid",
    amount_paid_cents: total,
    balance_due_cents: 0,
    payment_method: pm.invoice_method,
    card_brand: pm.card_brand,
    is_sales_receipt: true,
    orderMetadata: {
      qb_sales_receipt_txn_id: sr.txn_id,
      qb_sales_receipt_ref_number: sr.ref_number,
      qb_sales_receipt_edit_sequence: sr.edit_sequence,
      qb_invoice_ref_num: sr.ref_number,
      qb_invoices: [{ txn_id: sr.txn_id, ref_number: sr.ref_number, kind: "sales_receipt" }],
      referential_deposit: total / 100,
    },
    invoiceMetadata: {
      qb_payment_method: sr.payment_method_ref?.full_name ?? null,
      ...(sr.check_number ? { check_number: sr.check_number } : {}),
    },
  });

  // ── Pago embebido (misma forma que SR-27925) ─────────────────────────────
  const displayId = await allocatePaymentDisplayId(ctx.client);
  const reference = sr.check_number || sr.ref_number || null;
  const payment = firstId(
    await ctx.services.financeService.createCustomerPayments({
      customer_id: ids.customer_id,
      display_id: displayId,
      amount: total,
      method: pm.method,
      card_brand: pm.card_brand,
      reference,
      notes: `Backfill de QB Sales Receipt ${sr.ref_number ?? sr.txn_id} — pago embebido en el SR.`,
      received_at: at,
      created_by: BACKFILL_ACTOR,
      source: "pos",
      type: "payment",
      status: "applied",
      medusa_payment_synced: false,
      metadata: {
        deposit_type: "INVOICE",
        order_id: ids.order_id,
        order_document_number: ids.document_number,
        pos_payment_method: pm.method,
        card_brand: pm.card_brand,
        qb_payment_method: sr.payment_method_ref?.full_name ?? null,
        invoices_affected: [ids.invoice_id],
        invoices_affected_friendly: [`SR-${ids.invoice_number}`],
        qb_source: "sales_receipt",
        qb_sync_status: "synced",
        qb_txn_id: "SYNCED_VIA_RECEIPT",
        qb_parent_txn_id: sr.txn_id,
        qb_parent_ref_number: sr.ref_number,
        is_sales_receipt_payment: true,
        manually_imported: true,
        qb_backfill: ids.marker,
      },
      qb: { source: "sales_receipt", status: "yes", txn_id: sr.txn_id, edit_sequence: "No editable" },
    })
  );
  await backdateRows(ctx.client, "customer_payment", [payment], at);

  const application = firstId(
    await ctx.services.financeService.createPaymentApplications({
      payment_id: payment,
      invoice_id: ids.invoice_id,
      invoice_number: ids.invoice_number,
      order_id: ids.order_id,
      amount_applied: total,
      applied_at: at,
      applied_by: BACKFILL_ACTOR,
      metadata: { qb_backfill: ids.marker },
    })
  );
  await backdateRows(ctx.client, "payment_application", [application], at);

  const invoicePayment = await ctx.services.invoiceService.createInvoicePayments({
    invoice_id: ids.invoice_id,
    amount: total,
    payment_method: pm.method,
    notes: `Backfill — pago embebido en QB Sales Receipt ${sr.ref_number ?? sr.txn_id}`,
    created_by: BACKFILL_ACTOR,
    paid_at: at,
  });
  await backdateRows(ctx.client, "invoice_payment", [invoicePayment.id], at);

  // ── Pipeline: customer skipped · sales_order skipped · sales_receipt confirmed ──
  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: ids.order_id, referenceId: ids.customer_id, referenceType: "customer", step: "customer", status: "skipped",
    qbTxnId: customerRef.list_id, qbRefNumber: null, medusaRefNumber: null,
    payload: { txn_type: "SalesReceipt" }, error: "backfill: el cliente ya existe en QuickBooks",
  });
  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: ids.order_id, referenceId: null, referenceType: null, step: "sales_order", status: "skipped",
    qbTxnId: null, qbRefNumber: null, medusaRefNumber: ids.document_number,
    payload: { txn_type: "SalesReceipt" }, error: `Superseded by Sales Receipt ${sr.ref_number ?? sr.txn_id} (backfill from QB)`,
  });
  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: ids.order_id, referenceId: ids.invoice_id, referenceType: "pos_invoice", step: "sales_receipt", status: "confirmed",
    qbTxnId: sr.txn_id, qbRefNumber: sr.ref_number, medusaRefNumber: `SR-${ids.invoice_number}`,
    payload: { txn_type: "SalesReceipt", edit_sequence: sr.edit_sequence, source: `QB SalesReceipt ${sr.ref_number ?? sr.txn_id}` },
  });
  await backdateOrder(ctx, ids.order_id, sr.txn_date);
  return { ok: true, ids };
}
