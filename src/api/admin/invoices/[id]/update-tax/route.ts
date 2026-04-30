import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { updateInvoiceInQb } from "../../../../../lib/quickbooks/client/invoices";
import { getQbConfig } from "../../../../../lib/quickbooks/qb-config";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { resolveTaxListid } from "../../../../../lib/quickbooks/resolve-tax-listid";
import { QbSyncLogger } from "../../../../../lib/quickbooks/qb-sync-logger";
import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";

/**
 * POST /admin/invoices/:id/update-tax
 *
 * Corrects the tax on an existing pos_invoice (QB Invoice type only).
 * Sales Receipt invoices are blocked — they embed payment and cannot be
 * partially updated without distorting the received amount in QB.
 *
 * Body: { taxMode: 'florida' | 'exempt' }
 *
 * Effects:
 *  1. Recalculates pos_invoice totals (tax, untaxed_total, total, balance_due, amount_paid, status)
 *  2. Adjusts payment_application.amount_applied when total decreases (excess → available credit)
 *  3. Fires async QB Invoice MOD (fire & forget — does not block response)
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const { taxMode } = (req.body ?? {}) as { taxMode?: string };

  if (taxMode !== "florida" && taxMode !== "exempt") {
    res.status(400).json({ error: "taxMode must be 'florida' or 'exempt'" });
    return;
  }

  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const financeService = req.scope.resolve(FINANCE_MODULE);

  // ── 1. Load invoice ────────────────────────────────────────────────────────
  let invoice: any;
  try {
    invoice = await invoiceService.retrievePosInvoice(id);
  } catch {
    res.status(404).json({ error: `Invoice ${id} not found` });
    return;
  }

  if (invoice.status === "voided") {
    res.status(400).json({ error: "Cannot update tax on a voided invoice" });
    return;
  }

  // ── 2. Block Sales Receipts ────────────────────────────────────────────────
  const meta: Record<string, unknown> = (invoice as any).metadata ?? {};
  const isSalesReceipt = !!(meta.qb_is_sales_receipt ?? meta.is_sales_receipt);

  if (isSalesReceipt) {
    res.status(422).json({
      error:
        "Tax cannot be edited on a Sales Receipt invoice. " +
        "To correct taxes: void this invoice, update the order tax setting, then re-invoice.",
      code: "SALES_RECEIPT_TAX_LOCKED",
    });
    return;
  }

  // ── 3. Compute new totals (all values in cents) ────────────────────────────
  function getNum(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === "number") return val;
    if (typeof val === "string") return Number(val);
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if (typeof obj.toNumber === "function")
        return (obj.toNumber as () => number)();
      if (obj.numeric !== undefined) return Number(obj.numeric);
      if (obj.value !== undefined) return Number(obj.value);
    }
    return Number(val) || 0;
  }

  const subtotal = getNum(invoice.subtotal);
  const shipping = getNum(invoice.shipping);

  const newTax = taxMode === "florida" ? Math.round(subtotal * 0.07) : 0;
  const newTotal = subtotal + shipping + newTax;
  const newUntaxedTotal = subtotal + shipping;

  // ── 4. Load existing payments & recalculate balance ────────────────────────
  const payments = await invoiceService
    .listInvoicePayments({ invoice_id: id })
    .catch(() => [] as any[]);

  const totalPaid = payments.reduce(
    (sum: number, p: any) => sum + getNum(p.amount),
    0
  );

  const newBalanceDue = Math.max(0, newTotal - totalPaid);
  const newAmountPaid = Math.min(totalPaid, newTotal);
  const newStatus =
    newBalanceDue <= 0 ? "paid" : totalPaid > 0 ? "partial" : invoice.status;

  // ── 5. Update pos_invoice ──────────────────────────────────────────────────
  // Persist the QB SalesTaxItem ListID alongside the tax math so the QB
  // pipeline reads it directly instead of re-deriving from tax_total.
  const qbConfigForListid = await getQbConfig().catch(() => null);
  const qbTaxItemListid = qbConfigForListid
    ? resolveTaxListid(taxMode, qbConfigForListid)
    : null;
  const mergedMetadata = qbTaxItemListid
    ? { ...meta, qb_tax_item_listid: qbTaxItemListid }
    : meta;
  await invoiceService.updatePosInvoices({
    id,
    total: newTotal,
    tax: newTax,
    untaxed_total: newUntaxedTotal,
    balance_due: newBalanceDue,
    amount_paid: newAmountPaid,
    status: newStatus,
    ...(qbTaxItemListid ? { metadata: mergedMetadata } : {}),
  });

  // ── 6. Adjust payment_application when total decreases ────────────────────
  // If the customer paid the original (higher) total, the excess must become
  // available credit on the customer_payment rather than staying over-applied.
  const oldTotal = getNum(invoice.total);
  if (newTotal < oldTotal) {
    try {
      const apps: any[] = await financeService
        .listPaymentApplications({ invoice_id: id })
        .catch(() => []);

      for (const app of apps) {
        if (app.voided_at) continue;
        const currentApplied = getNum(app.amount_applied);
        if (currentApplied <= newTotal) continue;

        // Clamp amount_applied to the new total
        await financeService.updatePaymentApplications({
          id: app.id,
          amount_applied: newTotal,
        });

        // Re-evaluate customer_payment status
        const paymentRecord = await financeService
          .retrieveCustomerPayment(app.payment_id ?? app.payment?.id, {
            relations: ["applications"],
          })
          .catch(() => null);

        if (paymentRecord) {
          const paymentTotal = getNum(paymentRecord.amount);
          const stillApplied = (paymentRecord.applications ?? [])
            .filter((a: any) => !a.voided_at && a.id !== app.id)
            .reduce((sum: number, a: any) => sum + getNum(a.amount_applied), 0);
          const nowApplied = stillApplied + newTotal;

          const newPaymentStatus =
            nowApplied <= 0
              ? "available"
              : nowApplied < paymentTotal
                ? "partially_applied"
                : "applied";

          await financeService.updateCustomerPayments({
            id: paymentRecord.id,
            status: newPaymentStatus,
          });
        }
      }
    } catch (err: any) {
      // Non-blocking — log but don't fail the request
      console.error(
        "[update-tax] payment_application adjustment failed:",
        err.message
      );
    }
  }

  // ── 7. QB MOD — tracked in qb_sync_log, runs in background ───────────────
  const txnId = (meta.qb_invoice_txn_id ?? meta.qb_txn_id) as
    | string
    | undefined;

  if (txnId && process.env.QB_ORDER_FLOW_ENABLED === "true") {
    // Start log entry synchronously so the row is visible immediately in the UI
    QbSyncLogger.start({
      operation: "invoice",
      orderId: invoice.order_id ?? undefined,
      eventType: "invoice.tax_updated",
      triggeredBy: "manual",
      message: `Tax update on invoice ${invoice.invoice_number || id} → ${taxMode} (txnId: ${txnId})`,
      metadata: { invoiceId: id, taxMode, txnId },
    })
      .then((logId) => {
        QbSyncLogger.setOperationId(logId, "pending").catch(() => {});
        // Write upfront pipeline row so it appears immediately in the Pipeline Monitor
        writePipelineRow({
          orderId: invoice.order_id ?? null,
          referenceId: id,
          referenceType: "pos_invoice",
          step: "invoice_update",
          status: "pending",
          medusaRefNumber: invoice.invoice_number
            ? `INV-${invoice.invoice_number}`
            : null,
        }).catch(() => {});
        return getQbConfig().then((qbConfig) => {
          const payload = {
            txnId: txnId!,
            salesTaxCode:
              taxMode === "florida" ? qbConfig.defaultSalesTaxCode : undefined,
            taxExempt: taxMode === "exempt" ? (true as const) : undefined,
          };
          return updateInvoiceInQb(payload).then((result) => ({
            logId,
            result,
          }));
        });
      })
      .then(({ logId, result }) => {
        if (!result.success) {
          console.error(
            `[update-tax] QB Invoice MOD failed for ${txnId}:`,
            result.error
          );
          writePipelineRow({
            orderId: invoice.order_id ?? null,
            referenceId: id,
            referenceType: "pos_invoice",
            step: "invoice_update",
            status: "failed",
            medusaRefNumber: invoice.invoice_number
              ? `INV-${invoice.invoice_number}`
              : null,
            error: result.error ?? "QB update failed",
          }).catch(() => {});
          return QbSyncLogger.fail(logId, result.error ?? "QB update failed", {
            metadata: { txnId, taxMode },
          });
        }
        const opId = result.data?.operationId;
        console.log(
          `[update-tax] ✅ QB Invoice MOD queued for ${txnId} (op: ${opId})`
        );
        if (opId) QbSyncLogger.setOperationId(logId, opId).catch(() => {});
        writePipelineRow({
          orderId: invoice.order_id ?? null,
          referenceId: id,
          referenceType: "pos_invoice",
          step: "invoice_update",
          status: "confirmed",
          medusaRefNumber: invoice.invoice_number
            ? `INV-${invoice.invoice_number}`
            : null,
          bridgeOpId: opId ?? null,
          qbTxnId: txnId ?? null,
        }).catch(() => {});
        return QbSyncLogger.complete(logId, {
          qbTxnId: txnId,
          qbOperationId: opId,
          message: `Tax MOD queued — ${taxMode} (op: ${opId})`,
        });
      })
      .catch((err: Error) => {
        console.error(
          `[update-tax] QB MOD pipeline error for ${txnId}:`,
          err.message
        );
      });
  }

  // ── 8. Return updated invoice ──────────────────────────────────────────────
  const updated = await invoiceService.retrievePosInvoice(id);
  res.json({ invoice: updated });
}
