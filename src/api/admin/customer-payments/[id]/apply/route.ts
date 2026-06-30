/**
 * POST /admin/customer-payments/:id/apply
 * Apply available balance to an invoice.
 * Body: { invoice_id: string, amount: number, applied_by?: string, metadata?: object }
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import { maybeCompleteOrder } from "../../../../../lib/maybe-complete-order";
import { handlePosPaymentApplied } from "../../../../../lib/quickbooks/handlers/handle-pos-payment-applied";
import { writePipelineRow } from "../../../../../lib/quickbooks/pipeline/row-mutations";
import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
import {
  getAppliedInvoiceTotal,
  getNum,
} from "../../../invoices/payment-balance";
import { registerMedusaPayment } from "../../../invoices/register-medusa-payment";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const { invoice_id, amount, applied_by, metadata } = (req.body ?? {}) as {
    invoice_id?: string;
    amount?: number;
    applied_by?: string;
    metadata?: Record<string, unknown> | null;
  };

  if (!invoice_id)
    return res.status(400).json({ error: "invoice_id is required" });
  if (!amount || amount <= 0)
    return res
      .status(400)
      .json({ error: "amount must be positive (in cents)" });

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const invoiceService = req.scope.resolve(INVOICE_MODULE);

  try {
    // 1. Load payment and verify it has enough balance
    const payment = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.status === "voided")
      return res.status(400).json({ error: "Cannot apply a voided payment" });
    if (payment.status === "applied")
      return res
        .status(400)
        .json({ error: "Payment has already been fully applied" });

    // Block apply while a customer transfer is unresolved for this payment.
    // The transfer is deleting+recreating the QB ReceivePayment (moving it to a
    // new customer); applying now would bind it to an invoice mid-move and race
    // the QB delete. Symmetric with the transfer guard, which requires zero
    // active applications to start. Operator retries once the transfer settles.
    const xferPool = getDbPool();
    const { rows: pendingXfer } = await xferPool.query(
      `SELECT id FROM qb_order_pipeline
        WHERE reference_id = $1 AND step = 'transfer_payment'
          AND status NOT IN ('confirmed', 'cancelled', 'skipped')
        LIMIT 1`,
      [id]
    );
    if (pendingXfer.length > 0) {
      return res.status(409).json({
        error: "PAYMENT_TRANSFER_IN_PROGRESS",
        message:
          "This payment is being transferred to another customer. Wait for the transfer to finish before applying it.",
      });
    }

    const activeApps: any[] = (payment.applications ?? []).filter(
      (a: any) => !a.voided_at
    );
    const alreadyApplied = activeApps.reduce(
      (s: number, a: any) => s + Number(a.amount_applied ?? 0),
      0
    );
    const available = Math.max(0, Number(payment.amount) - alreadyApplied);

    if (available <= 0) {
      return res
        .status(400)
        .json({ error: "This payment has no available balance to apply." });
    }

    // 2. Load invoice
    const invoice = await invoiceService.retrievePosInvoice(invoice_id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "voided")
      return res
        .status(400)
        .json({ error: "Cannot apply to a voided invoice" });

    // Auto-clamp: never apply more than what the invoice still owes,
    // and never more than what the deposit has available. The unused portion
    // stays on the CustomerPayment as available credit for future invoices.
    const invoiceTotal = getNum((invoice as any).total);
    const invoiceAmountPaid = await getAppliedInvoiceTotal(req.scope, invoice_id);
    const invoiceBalanceDue = Math.max(0, invoiceTotal - invoiceAmountPaid);

    if (invoiceBalanceDue <= 0) {
      return res.status(400).json({
        error: "Invoice is already paid in full — no balance to apply.",
      });
    }

    const requestedAmount = Number(amount);
    const effectiveAmount = Math.min(
      requestedAmount,
      invoiceBalanceDue,
      available
    );
    const overflowAmount = requestedAmount - effectiveAmount;

    const now = new Date();

    // 3. Create the application
    const createdApplication = await financeService.createPaymentApplications({
      payment_id: id,
      invoice_id,
      order_id: invoice.order_id,
      amount_applied: effectiveAmount,
      applied_at: now,
      applied_by: applied_by ?? null,
      metadata: metadata ?? null,
    });
    const applicationId =
      (createdApplication as any)?.id ??
      (Array.isArray(createdApplication)
        ? (createdApplication[0] as any)?.id
        : null);

    // 4. Create the corresponding InvoicePayment so future recalculations stay consistent.
    await invoiceService.createInvoicePayments({
      invoice_id,
      amount: effectiveAmount,
      payment_method: "credit",
      notes: `Applied from deposit/payment ${payment.reference || id}`,
      created_by: applied_by ?? null,
      paid_at: now,
    });

    // 5. Update invoice balance from the authoritative invoice_payments sum
    const totalPaid = await getAppliedInvoiceTotal(req.scope, invoice_id);
    const balanceDue = Math.max(0, invoiceTotal - totalPaid);
    await invoiceService.updatePosInvoices({
      id: invoice_id,
      amount_paid: totalPaid,
      balance_due: balanceDue,
      status: balanceDue <= 0 ? "paid" : "partial",
    });

    // 6. Register capture in Medusa native payment module so order.payment_status updates
    if (invoice.order_id) {
      await registerMedusaPayment(req.scope, {
        order_id: invoice.order_id,
        amount: effectiveAmount,
        payment_method: payment.method,
        invoice_total: invoiceTotal,
      }).catch(() => {}); // non-fatal
    }

    // 7. Update payment status — ONLY count invoice-bound applications toward
    //    the "applied" / "partially_applied" status. Order-only applications
    //    reserve credit but are not "applied" until their invoice is issued.
    const invoiceAppliedExisting = activeApps
      .filter((a: any) => !!a.invoice_id)
      .reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0);
    const newInvoiceApplied = invoiceAppliedExisting + effectiveAmount;
    const newStatus =
      newInvoiceApplied >= Number(payment.amount)
        ? "applied"
        : "partially_applied";
    await financeService.updateCustomerPayments({ id, status: newStatus });

    const updated = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });

    // 8. QB Sync — enqueue apply_payment row + direct-exec handler so the
    // consolidator updates the existing ReceivePayment in QuickBooks with
    // AppliedToTxnAdd against this invoice. Mirrors the pattern used by
    // src/api/admin/invoices/[id]/payments/route.ts.
    const qbFlowEnabled = process.env.QB_ORDER_FLOW_ENABLED === "true";
    if (qbFlowEnabled && invoice.order_id && applicationId) {
      const medusaRefNumber = payment.display_id
        ? `PAY-${payment.display_id}`
        : null;

      // ORPHAN CPAY GUARD (2026-05-23 Yeni 2498 incident):
      // If the source cpay is unsynced AND not embedded in a Sales Receipt,
      // make sure there's a 'pending' payment pipeline row for it before we
      // enqueue apply_payment. Without this, handlePosPaymentApplied can't
      // resolve a source row (resolveSourcePipelineRowId returns null) and
      // writes status='failed' with "Payment not yet synced to QB...". This
      // happens when CompleteOrderModal aborted mid-flow (cobro succeeded,
      // cpay created via /admin/finance/payments with skip_qb_sync=true, but
      // /admin/invoices was never called) and the cashier recovered by
      // creating the invoice via a different path + Apply Credit.
      const srEmbedded =
        (payment as any).metadata?.qb_source === "sales_receipt" ||
        (payment as any).metadata?.is_sales_receipt_payment === true ||
        (payment as any).metadata?.qb_sync_status === "pending_sr";
      const paymentTxnId = (payment as any).metadata?.qb_txn_id as
        | string
        | undefined;
      if (!paymentTxnId && !srEmbedded) {
        try {
          const pool = getDbPool();
          const { rows: existing } = await pool.query(
            `SELECT id, status FROM qb_order_pipeline
              WHERE reference_id = $1 AND step = 'payment'
              ORDER BY created_at DESC LIMIT 1`,
            [id]
          );
          const needsPromotion =
            existing.length === 0 ||
            existing[0].status === "waiting" ||
            existing[0].status === "failed" ||
            existing[0].status === "skipped";
          if (needsPromotion) {
            await writePipelineRow({
              orderId: invoice.order_id,
              referenceId: id,
              referenceType: "customer_payment",
              step: "payment",
              status: "pending",
              medusaRefNumber,
            });
            console.info(
              `[customer-payments/:id/apply] Promoted orphan cpay ${id} payment row to pending (no qb_txn_id, not SR-embedded)`
            );
          }
        } catch (promoteErr: any) {
          console.warn(
            `[customer-payments/:id/apply] Could not promote orphan payment row for ${id}: ${promoteErr.message}`
          );
        }
      }

      try {
        await writePipelineRow({
          orderId: invoice.order_id,
          referenceId: applicationId,
          referenceType: "payment_application",
          step: "apply_payment",
          status: "waiting",
          medusaRefNumber,
        });
      } catch (rowErr: any) {
        console.warn(
          `[customer-payments/:id/apply] Could not write pipeline row: ${rowErr.message}`
        );
      }

      setTimeout(async () => {
        try {
          await handlePosPaymentApplied({
            event: {
              name: "pos.payment.applied",
              data: {
                payment_id: id,
                invoice_id,
                order_id: invoice.order_id,
                amount_applied: effectiveAmount,
                application_id: applicationId,
              },
            } as any,
            container: req.scope as any,
            pluginOptions: {},
          } as any);
        } catch (execErr: any) {
          console.error(
            `[customer-payments/:id/apply] Direct exec QB sync failed: ${execErr.message}`
          );
        }
      }, 100);
    }

    const newAvailable = Math.max(
      0,
      Number(payment.amount) - (alreadyApplied + effectiveAmount)
    );

    // Best-effort native completion now that this payment settled against the
    // invoice (idempotent + advisory-locked + non-fatal). The auto-complete
    // subscriber is the retry net if the order isn't eligible yet.
    if (invoice.order_id) {
      try {
        await maybeCompleteOrder(req.scope, invoice.order_id);
      } catch {
        /* non-fatal */
      }
    }

    return res.json({
      payment: updated,
      requested_amount: requestedAmount,
      applied_amount: effectiveAmount,
      overflow_amount: overflowAmount,
      remaining_payment_balance: newAvailable,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
