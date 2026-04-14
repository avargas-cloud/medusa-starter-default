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
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.params.id;

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
      if (p.status === "available" || p.status === "partially_applied") {
        const totalApplied = p.applications
          .filter((app: any) => !app.voided_at)
          .reduce(
            (sum: number, app: any) => sum + Number(app.amount_applied),
            0
          );

        const remainingAmountCents = Number(p.amount) - totalApplied;

        if (remainingAmountCents > 0) {
          availableCreditCents += remainingAmountCents;
          availableCreditsList.push({
            ...p,
            remaining_amount: remainingAmountCents / 100,
            locked_order_id: p.locked_order_id as string | null,
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
