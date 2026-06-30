import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../../modules/invoices";

/**
 * GET /admin/finance/customers/:id/balance
 *
 * Core reporting endpoint. Computes a customer's unified statement.
 * Calculates:
 * 1. Available Credit (sum of POS payments that haven't been applied yet)
 * 2. Total Accounts Receivable (AR) (sum of balance_due entirely out of POS invoices)
 * 3. Net Balance (AR - Available Credit)
 * 4. Unapplied POS Payments array
 * 5. Outstanding Invoices array
 *
 * Optional query params (target-aware mode — used by the Link/Unlink credit panel):
 *   ?invoice_id=<id>  → for each credit, resolve any active application to THAT invoice
 *   ?order_id=<id>    → resolve any active ORDER-ONLY reservation to THAT order
 * When a target is supplied, a credit FULLY consumed by that target (remaining_amount = 0)
 * is STILL returned (so it can be unlinked); each credit gains target_application_id(s),
 * target_linked_amount_cents and target_relation. Without these params the response is
 * byte-identical to the legacy behaviour.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.params.id;
  const targetInvoiceId = (req.query.invoice_id as string) || null;
  const targetOrderId = (req.query.order_id as string) || null;

  if (!customerId) {
    return res.status(400).json({ error: "Customer ID is required" });
  }

  try {
    const financeService = req.scope.resolve(FINANCE_MODULE);
    const invoiceService = req.scope.resolve(INVOICE_MODULE);

    // 1. Get Available Credit (from pure POS payments that are not fully applied)
    // Note: web payments are ALWAYS 'applied', so they are excluded naturally
    const unappliedPayments = await financeService.listCustomerPayments(
      {
        customer_id: customerId,
      },
      {
        relations: ["applications"], // Need this to calculate exact remaining amounts if partially_applied
      }
    );

    let availableCreditCents = 0;
    const availableCreditsList: any[] = [];

    unappliedPayments.forEach((p: any) => {
      // A credit is still spendable when it carries a positive remaining
      // balance — even after a *partial* refund. We mirror the canonical
      // remaining formula used by the refund route
      // (admin/customer-payments/:id/refund):
      //   remaining = amount - INVOICE-BOUND applications - metadata.refund_amount
      // 'partial_refunded' must be included or a partially-refunded store
      // credit vanishes entirely from available credit.
      // 'applied' is included too: a deposit whose only application is ORDER-ONLY
      // (invoice_id IS NULL — a soft reservation, not a settlement) may carry
      // status='applied' yet still be fully spendable. The remaining>0 guard
      // below drops genuinely invoice-consumed payments. Only 'voided' and full
      // 'refunded' are excluded outright (they net to <= 0 anyway).
      if (p.status !== "voided" && p.status !== "refunded") {
        const activeApps = (p.applications ?? []).filter(
          (app: any) => !app.voided_at
        );

        // Only INVOICE-BOUND applications (invoice_id NOT NULL) truly consume the
        // credit. Order-only applications (invoice_id IS NULL) are a soft
        // reservation against an order, not a final settlement — the deposit must
        // still appear as available credit in the payment modals (and gets
        // converted to invoice-bound by the rebind subscriber when the invoice is
        // issued). Counting them here is what made deposits vanish from the
        // RELATED/ADDITIONAL credit lists.
        const totalApplied = activeApps
          .filter((app: any) => app.invoice_id != null)
          .reduce(
            (sum: number, app: any) => sum + Number(app.amount_applied),
            0
          );

        const totalReserved = activeApps.reduce(
          (sum: number, app: any) => sum + Number(app.amount_applied),
          0
        );

        const refundedCents = Number(p.metadata?.refund_amount ?? 0);

        const remainingAmountCents =
          Number(p.amount) - totalApplied - refundedCents;

        // Target-aware resolution (Link/Unlink panel). The ACTIVE applications
        // tying THIS credit to the requested target. For an invoice target we
        // match invoice_id; for an order target we match the ORDER-ONLY
        // reservation (order_id + invoice_id NULL). Endpoint choice for unlink
        // (void vs unlink) is decided downstream from app.invoice_id, never UI.
        let targetApps: any[] = [];
        let targetRelation: "invoice" | "order" | null = null;
        if (targetInvoiceId) {
          targetApps = activeApps.filter(
            (app: any) => app.invoice_id === targetInvoiceId
          );
          if (targetApps.length) targetRelation = "invoice";
        } else if (targetOrderId) {
          targetApps = activeApps.filter(
            (app: any) =>
              app.order_id === targetOrderId &&
              (app.invoice_id === null || app.invoice_id === undefined)
          );
          if (targetApps.length) targetRelation = "order";
        }
        const targetApplicationIds = targetApps.map((app: any) => app.id);
        const targetLinkedAmountCents = targetApps.reduce(
          (sum: number, app: any) => sum + Number(app.amount_applied),
          0
        );

        // Include a credit when it still has spendable balance OR when it is
        // linked to the current target. The latter is critical: a credit FULLY
        // consumed by this target has remaining_amount = 0 and would otherwise
        // vanish from the list — making it impossible to unlink. (Bug #1.)
        if (remainingAmountCents > 0 || targetApps.length > 0) {
          // Only genuinely-spendable balance feeds the available-credit total;
          // a target-linked-but-consumed credit contributes 0 here.
          if (remainingAmountCents > 0) {
            availableCreditCents += remainingAmountCents;
          }
          availableCreditsList.push({
            ...p,
            remaining_amount: Math.max(0, remainingAmountCents) / 100,
            locked_order_id: p.locked_order_id as string | null,
            // Target-aware fields (null/0/[] when no target query param given).
            target_application_id: targetApplicationIds[0] ?? null,
            target_application_ids: targetApplicationIds,
            target_linked_amount_cents: targetLinkedAmountCents,
            target_relation: targetRelation,
            // How much of this credit could still be applied/reserved, so the
            // UI can clamp the Link amount without a second round-trip.
            invoice_spendable_cents: Math.max(
              0,
              Number(p.amount) - totalApplied
            ),
            order_reservable_cents: Math.max(
              0,
              Number(p.amount) - totalReserved
            ),
          });
        }
      }
    });

    // 2. Get AR from Outstanding Invoices
    // Fetch PosInvoices for this customer that are NOT paid and NOT voided
    const allInvoices = await invoiceService.listPosInvoices({
      customer_id: customerId,
    });

    const outstandingInvoices = allInvoices.filter(
      (inv: any) =>
        inv.status !== "voided" &&
        inv.status !== "paid" &&
        Number(inv.balance_due) > 0
    );

    const totalArOutstandingCents = outstandingInvoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.balance_due),
      0
    );
    const totalArOutstanding = totalArOutstandingCents / 100;

    // 3. Computed Balances in DOLLARS for frontend
    const availableCredit = availableCreditCents / 100;
    const netBalance = totalArOutstanding - availableCredit;

    return res.json({
      summary: {
        total_available_credit: availableCredit,
        total_ar_outstanding: totalArOutstanding,
        net_balance: netBalance,
      },
      details: {
        available_credits: availableCreditsList,
        outstanding_invoices: outstandingInvoices.sort((a: any, b: any) => {
          const dA = new Date(a.issued_at || 0).getTime();
          const dB = new Date(b.issued_at || 0).getTime();
          return dB - dA; // Descending
        }),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
