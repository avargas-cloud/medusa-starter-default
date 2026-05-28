import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../../modules/invoices";

/**
 * GET /admin/finance/customers/:id/open-orders
 *
 * Returns Medusa orders eligible to receive a direct payment application
 * (no PosInvoice yet). Used by payments/new to render the "Medusa Orders"
 * selectable box alongside outstanding invoices.
 *
 * Eligibility:
 *   • Order belongs to the customer
 *   • status NOT IN ('draft','canceled','cancelled')
 *   • Order has NO non-voided PosInvoice (would otherwise be in invoice list)
 *   • Outstanding > 0 (total minus active PaymentApplications)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.params.id;
  if (!customerId) {
    return res.status(400).json({ error: "Customer ID is required" });
  }

  try {
    const financeService = req.scope.resolve(FINANCE_MODULE);
    const invoiceService = req.scope.resolve(INVOICE_MODULE);
    const query = req.scope.resolve("query");

    // 1. Fetch Medusa orders for this customer (non-draft, non-canceled).
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "total",
        "currency_code",
        "created_at",
        "metadata",
      ],
      filters: { customer_id: customerId },
    });

    const eligibleOrders = (orders ?? []).filter((o: any) => {
      const s = String(o.status ?? "").toLowerCase();
      return s !== "draft" && s !== "canceled" && s !== "cancelled";
    });

    if (eligibleOrders.length === 0) {
      return res.json({ open_orders: [] });
    }

    const orderIds = eligibleOrders.map((o: any) => o.id);

    // 2. Drop orders that already have a non-voided PosInvoice — those go via
    //    the invoice flow.
    const invoices = await invoiceService.listPosInvoices(
      { order_id: orderIds },
      { take: 1000 }
    );
    const invoicedOrderIds = new Set(
      invoices
        .filter((inv: any) => inv.status !== "voided")
        .map((inv: any) => inv.order_id)
    );

    // 3. Sum active PaymentApplications per order_id to compute outstanding.
    const applications = await financeService.listPaymentApplications(
      { order_id: orderIds },
      { take: 5000 }
    );
    const appliedByOrder = new Map<string, number>();
    for (const app of applications) {
      if ((app as any).voided_at) continue;
      const oid = (app as any).order_id;
      appliedByOrder.set(
        oid,
        (appliedByOrder.get(oid) ?? 0) + Number((app as any).amount_applied)
      );
    }

    // order.total is in cents (BigNumber). Match invoice convention.
    const open_orders = eligibleOrders
      .filter((o: any) => !invoicedOrderIds.has(o.id))
      .map((o: any) => {
        const total = Number(o.total) || 0;
        const applied = appliedByOrder.get(o.id) ?? 0;
        const outstanding = Math.max(0, total - applied);
        return {
          id: o.id,
          display_id: o.display_id ?? null,
          status: o.status,
          total_cents: total,
          applied_cents: applied,
          outstanding_cents: outstanding,
          currency_code: o.currency_code ?? "usd",
          created_at: o.created_at,
        };
      })
      .filter((o: any) => o.outstanding_cents > 0)
      .sort(
        (a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

    return res.json({ open_orders });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
