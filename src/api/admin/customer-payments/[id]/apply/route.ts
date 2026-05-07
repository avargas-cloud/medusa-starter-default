/**
 * POST /admin/customer-payments/:id/apply
 * Apply available balance to an invoice.
 * Body: { invoice_id: string, amount: number, applied_by?: string }
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
import {
  getAppliedInvoiceTotal,
  getNum,
} from "../../../invoices/payment-balance";
import { registerMedusaPayment } from "../../../invoices/register-medusa-payment";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const { invoice_id, amount, applied_by } = req.body as any;

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
    await financeService.createPaymentApplications({
      payment_id: id,
      invoice_id,
      order_id: invoice.order_id,
      amount_applied: effectiveAmount,
      applied_at: now,
      applied_by: applied_by ?? null,
    });

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
    await invoiceService.updatePosInvoices(
      { id: invoice_id },
      {
        amount_paid: totalPaid,
        balance_due: balanceDue,
        status: balanceDue <= 0 ? "paid" : "partial",
      }
    );

    // 6. Register capture in Medusa native payment module so order.payment_status updates
    if (invoice.order_id) {
      await registerMedusaPayment(req.scope, {
        order_id: invoice.order_id,
        amount: effectiveAmount,
        payment_method: payment.method,
        invoice_total: invoiceTotal,
      }).catch(() => {}); // non-fatal
    }

    // 7. Update payment status
    const newApplied = alreadyApplied + effectiveAmount;
    const newAvailable = Math.max(0, Number(payment.amount) - newApplied);
    const newStatus = newAvailable <= 0 ? "applied" : "partially_applied";
    await financeService.updateCustomerPayments({ id, status: newStatus });

    const updated = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
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
