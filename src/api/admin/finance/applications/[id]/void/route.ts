import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../../modules/invoices";

/**
 * POST /admin/finance/applications/:id/void
 * Voids a specific payment application.
 * Restores the applied amount back to the CustomerPayment's available balance
 * and correctly updates the target PosInvoice.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const applicationId = req.params.id!;
  const { void_reason, voided_by } = req.body as any;

  if (!void_reason) {
    return res.status(400).json({ error: "void_reason is required" });
  }

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const eventBus = req.scope.resolve(Modules.EVENT_BUS);

  try {
    // 1. Retrieve the application directly
    const dbApplications = await financeService.listPaymentApplications(
      { id: applicationId },
      {
        relations: ["payment"],
      }
    );

    if (!dbApplications || dbApplications.length === 0) {
      return res.status(404).json({ error: "Payment application not found" });
    }

    const application = dbApplications[0] as any;

    if (application.voided_at) {
      return res
        .status(400)
        .json({ error: "This payment application is already voided" });
    }

    // 2. We can only void POS source applications (web applications are immutable as they reflect external reality)
    if (application.payment.source === "web") {
      return res
        .status(403)
        .json({
          error:
            "Cannot void web checkout applications via the finance module.",
        });
    }

    // 3. Mark the application as voided
    const voidedApplication = await financeService.updatePaymentApplications({
      id: applicationId,
      voided_at: new Date(),
      void_reason: void_reason,
      voided_by: voided_by || null,
    });

    // 4. Restore the CustomerPayment's status back to anything but "applied"
    // Wait... actually, we just recalculate the total applied manually again, ignoring this voided app
    const currentPaymentDesc = await financeService.retrieveCustomerPayment(
      application.payment.id,
      {
        relations: ["applications"],
      }
    );

    const activeApplications = currentPaymentDesc.applications.filter(
      (app: any) => !app.voided_at
    );
    const totalStillApplied = activeApplications.reduce(
      (sum: number, app: any) => sum + Number(app.amount_applied),
      0
    );

    const newPaymentStatus =
      totalStillApplied === 0 ? "available" : "partially_applied";

    await financeService.updateCustomerPayments({
      id: currentPaymentDesc.id,
      status: newPaymentStatus,
    });

    // 5. Update the Invoice (deduct from amount_paid, rebuild balance)
    if (application.invoice_id) {
      const invoice = await invoiceService.retrievePosInvoice(
        application.invoice_id
      );
      if (invoice) {
        // Here is a slightly complex part: we don't have a 1:1 map between PaymentApplication and InvoicePayment ids natively.
        // We'll void the InvoicePayment that matches exactly the amount + creation time.
        // Alternatively, we just create a compensating NEGATIVE InvoicePayment
        await invoiceService.createInvoicePayments({
          invoice_id: application.invoice_id,
          amount: -application.amount_applied,
          payment_method: "credit",
          notes: `Voided application of payment ${application.payment.reference || application.payment.id}: ${void_reason}`,
          created_by: voided_by || null,
          paid_at: new Date(),
        });

        // Recalculate invoice totals
        const allInvoicePayments = await invoiceService.listInvoicePayments({
          invoice_id: application.invoice_id,
        });
        const totalInvoicePaid = allInvoicePayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0
        );
        const balanceDue = Math.max(
          0,
          Number(invoice.total) - totalInvoicePaid
        );
        const newInvoiceStatus = balanceDue <= 0 ? "paid" : "partial"; // Or possibly 'issued' if 0

        await invoiceService.updatePosInvoices(
          { id: application.invoice_id },
          {
            amount_paid: totalInvoicePaid,
            balance_due: balanceDue,
            status:
              newInvoiceStatus === "partial" && totalInvoicePaid === 0
                ? "issued"
                : newInvoiceStatus,
          }
        );
      }
    }

    // 6. Fire event for QB Sync to Unapply the payment from the Invoice
    try {
      await eventBus.emit({
        name: "pos.payment.unapplied",
        data: {
          payment_id: application.payment.id,
          invoice_id: application.invoice_id,
          amount_unapplied: application.amount_applied,
          application_id: application.id,
        },
      });
    } catch (emitErr: any) {
      req.scope
        .resolve("logger")
        .error(`Failed to emit pos.payment.unapplied: ${emitErr.message}`);
    }

    return res.json({ success: true, application: voidedApplication });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
