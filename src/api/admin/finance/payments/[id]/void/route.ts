import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { handlePosPaymentVoided } from "../../../../../../lib/quickbooks/handlers/handle-pos-payment-voided";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../../modules/invoices";

/**
 * POST /admin/finance/payments/:id/void
 *
 * Voids an entire CustomerPayment:
 *  1. Guards: not already voided/refunded, not web-sourced
 *  2. Voids all active PaymentApplications (restores invoice balance_due)
 *  3. Sets payment.status = 'voided'
 *  4. Fires QB Bridge void (async, via setTimeout — same pattern as payment creation)
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const paymentId = req.params.id as string;
  const { void_reason, voided_by } = req.body as {
    void_reason?: string;
    voided_by?: string;
  };

  if (!void_reason) {
    return res.status(400).json({ error: "void_reason is required" });
  }

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const logger = req.scope.resolve("logger");

  try {
    // 1. Fetch payment with its applications
    const payment = await financeService.retrieveCustomerPayment(paymentId, {
      relations: ["applications"],
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    if (payment.status === "voided") {
      return res.status(400).json({ error: "Payment is already voided" });
    }

    if (["refunded", "partial_refunded"].includes(payment.status)) {
      return res.status(400).json({
        error: "Cannot void a payment that has already been refunded",
      });
    }

    if ((payment as any).source === "web") {
      return res
        .status(403)
        .json({ error: "Cannot void web checkout payments via the POS" });
    }

    // 2. Void all active applications — same logic as applications/[id]/void but in bulk
    const activeApplications = ((payment as any).applications ?? []).filter(
      (a: any) => !a.voided_at
    );

    for (const app of activeApplications) {
      // 2a. Mark application as voided
      await financeService.updatePaymentApplications({
        id: app.id,
        voided_at: new Date(),
        void_reason: `Payment voided: ${void_reason}`,
        voided_by: voided_by ?? null,
      });

      // 2b. Restore invoice balance_due if linked
      if (app.invoice_id) {
        try {
          // Compensating entry to reverse the applied amount
          await invoiceService.createInvoicePayments({
            invoice_id: app.invoice_id,
            amount: -app.amount_applied,
            payment_method: "credit",
            notes: `Payment voided (${void_reason})`,
            created_by: voided_by ?? null,
            paid_at: new Date(),
          });

          const allInvoicePayments = await invoiceService.listInvoicePayments({
            invoice_id: app.invoice_id,
          });
          const totalInvoicePaid = allInvoicePayments.reduce(
            (sum: number, p: any) => sum + Number(p.amount),
            0
          );
          const invoice = await invoiceService.retrievePosInvoice(
            app.invoice_id
          );
          const balanceDue = Math.max(
            0,
            Number(invoice.total) - totalInvoicePaid
          );
          const newStatus =
            totalInvoicePaid <= 0
              ? "issued"
              : balanceDue <= 0
                ? "paid"
                : "partial";

          await invoiceService.updatePosInvoices(
            { id: app.invoice_id },
            {
              amount_paid: totalInvoicePaid,
              balance_due: balanceDue,
              status: newStatus,
            }
          );
        } catch (invoiceErr: any) {
          logger.warn(
            `[void-payment] Could not restore invoice ${app.invoice_id}: ${invoiceErr.message}`
          );
        }
      }
    }

    // 3. Mark payment as voided
    const updatedPayment = await financeService.updateCustomerPayments({
      id: paymentId,
      status: "voided",
      metadata: {
        ...(payment as any).metadata,
        void_reason,
        voided_by: voided_by ?? null,
        voided_at: new Date().toISOString(),
        qb_sync_status: "voiding",
      },
    });

    // 4. Fire QB Bridge void (direct exec, bypasses BullMQ — same pattern as payment creation)
    if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
      setTimeout(async () => {
        try {
          await handlePosPaymentVoided({
            event: {
              name: "pos.payment.voided",
              data: { payment_id: paymentId },
            },
            container: req.scope as any,
            pluginOptions: {},
          });
        } catch (execErr: any) {
          logger.error(
            `[void-payment] QB void handler failed: ${execErr.message}`
          );
        }
      }, 100);
    }

    return res.json({ success: true, payment: updatedPayment });
  } catch (err: any) {
    logger.error(`[void-payment] ❌ ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
