/**
 * POST /admin/customer-payments/:id/apply
 * Apply available balance to an invoice.
 * Body: { invoice_id: string, amount: number, applied_by?: string }
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
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

    if (amount > available) {
      return res.status(400).json({
        error: `Amount (${amount}) exceeds available balance (${available})`,
      });
    }

    // 2. Load invoice
    const invoice = await invoiceService.retrievePosInvoice(invoice_id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "voided")
      return res
        .status(400)
        .json({ error: "Cannot apply to a voided invoice" });

    const now = new Date();

    // 3. Create the application
    await financeService.createPaymentApplications({
      payment_id: id,
      invoice_id,
      order_id: invoice.order_id,
      amount_applied: amount,
      applied_at: now,
      applied_by: applied_by ?? null,
    });

    // 4. Update invoice balance
    const allInvPayments = await invoiceService.listInvoicePayments({
      invoice_id,
    });
    const totalPaid =
      allInvPayments.reduce((s: number, p: any) => s + Number(p.amount), 0) +
      amount;
    const balanceDue = Math.max(0, Number(invoice.total) - totalPaid);
    await invoiceService.updatePosInvoices(
      { id: invoice_id },
      {
        amount_paid: totalPaid,
        balance_due: balanceDue,
        status: balanceDue <= 0 ? "paid" : "partial",
      }
    );

    // 5a. Register capture in Medusa native payment module so order.payment_status updates
    if (invoice.order_id) {
      await registerMedusaPayment(req.scope, {
        order_id: invoice.order_id,
        amount,
        payment_method: payment.method,
        invoice_total: Number(invoice.total),
      }).catch(() => {}); // non-fatal
    }

    // 5. Update payment status
    const newApplied = alreadyApplied + amount;
    const newAvailable = Math.max(0, Number(payment.amount) - newApplied);
    const newStatus = newAvailable <= 0 ? "applied" : "partially_applied";
    await financeService.updateCustomerPayments({ id, status: newStatus });

    const updated = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
    return res.json({ payment: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
