import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { refreshOrderDocsForPayment } from "../../../_lib/refresh-order-docs";

/**
 * POST /admin/finance/applications/:id/unlink
 *
 * Non-destructive removal of an order-only PaymentApplication
 * (invoice_id IS NULL). The row is hard-deleted so the audit trail does
 * not surface a "Reversal" — semantically the link is treated as if it
 * never happened. Credit returns immediately to the payment's available
 * balance.
 *
 * Only allowed when:
 *   • application.invoice_id IS NULL (order-only)
 *   • application has not been voided already
 *   • parent payment.source !== 'web' (web payments are immutable)
 *
 * For invoice-bound applications use POST /admin/finance/applications/:id/void
 * instead — that path is destructive on purpose because it has to compensate
 * the invoice ledger and QB sync.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const applicationId = req.params.id!;

  const financeService = req.scope.resolve(FINANCE_MODULE);

  try {
    const apps = await financeService.listPaymentApplications(
      { id: applicationId },
      { relations: ["payment"] }
    );

    if (!apps || apps.length === 0) {
      return res
        .status(404)
        .json({ error: "Payment application not found" });
    }

    const application = apps[0] as Record<string, unknown> & {
      invoice_id: string | null;
      voided_at: string | null;
      payment_id: string;
      payment?: { source?: string };
    };

    if (application.invoice_id) {
      return res.status(400).json({
        error:
          "Invoice-bound applications must be voided, not unlinked. Use POST /admin/finance/applications/:id/void.",
      });
    }
    if (application.voided_at) {
      return res
        .status(400)
        .json({ error: "Application is already voided/unlinked" });
    }
    if (application.payment?.source === "web") {
      return res.status(403).json({
        error:
          "Cannot unlink applications on web checkout payments — they are immutable.",
      });
    }

    // Hard delete the row. No InvoicePayment, no QB pipeline, no invoice
    // balance update to undo — order-only applications never touch any of
    // those side effects.
    await financeService.deletePaymentApplications([applicationId]);

    // Restore the payment status. Order-only links don't change status (per
    // the new business rule), but in case any historical row was at
    // partially_applied/applied because of an order link, flip back to
    // 'available' when invoice-bound consumption is 0.
    const fresh = await financeService.retrieveCustomerPayment(
      application.payment_id,
      { relations: ["applications"] }
    );
    const activeInvoiceApplied = (fresh.applications ?? [])
      .filter((a: Record<string, unknown>) => !a.voided_at && !!a.invoice_id)
      .reduce(
        (s: number, a: Record<string, unknown>) =>
          s + Number(a.amount_applied ?? 0),
        0
      );
    const newStatus =
      activeInvoiceApplied >= Number(fresh.amount)
        ? "applied"
        : activeInvoiceApplied > 0
        ? "partially_applied"
        : "available";

    if (fresh.status !== "voided" && fresh.status !== "refunded") {
      await financeService.updateCustomerPayments({
        id: application.payment_id,
        status: newStatus,
      });
    }

    // Unlinking removed money from an order, so its search doc is stale:
    // effective_payment and is_unpaid are computed at index time. Never fatal.
    await refreshOrderDocsForPayment(req.scope, application.payment_id);

    return res.json({
      success: true,
      unlinked_application_id: applicationId,
      payment_id: application.payment_id,
    });
  } catch (err: unknown) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
}
