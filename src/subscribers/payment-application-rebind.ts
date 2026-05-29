/**
 * payment-application-rebind.ts
 *
 * When a PosInvoice is created for a Medusa Order that already has order-only
 * PaymentApplications (invoice_id IS NULL), this subscriber rebinds them to
 * the newly created invoice. If the invoice covers only a fraction of the
 * order total (multi-invoice partial-ship scenarios), it prorates: the
 * application is split into a bound share + a remaining dangling share that
 * waits for the next invoice.
 *
 * Prorate ratio = invoice_total / remaining_order_capacity
 *   remaining_order_capacity = order.total − sum(other non-voided invoices for the order)
 * This makes sequential invoice creation converge to fully-bound applications
 * by the time the order is fully invoiced.
 *
 * Linked plan: payments-treasury-refactor-scope (P1).
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { FINANCE_MODULE } from "../modules/finance";
import { INVOICE_MODULE } from "../modules/invoices";
import { getNum } from "../api/admin/invoices/payment-balance";
import { computeProrateShare, computeProrateRatio } from "./payment-application-rebind.lib";

interface InvoiceCreatedData {
  id?: string;
  invoice_id?: string;
  order_id?: string;
  is_sales_receipt?: boolean;
}

export default async function paymentApplicationRebindHandler({
  event,
  container,
}: SubscriberArgs<InvoiceCreatedData>) {
  const logger = container.resolve("logger");

  // DISABLED by default 2026-05-29 — business rule: store credits / deposits are
  // NEVER auto-applied. The cashier must explicitly SELECT a credit to apply it.
  // Auto-binding a deposit to its invoice on pos.invoice.created violated that
  // rule. Binding now happens only through the manual apply route, which CONVERTS
  // an existing order-only application to invoice-bound (see
  // finance/payments/[id]/apply/route.ts), so there is no double-count. Set
  // PAY_REBIND_AUTO_APPLY=true to restore the old auto-rebind behavior.
  if (process.env.PAY_REBIND_AUTO_APPLY !== "true") {
    logger.info(
      "[PAY-REBIND] auto-rebind disabled — credits are applied manually only."
    );
    return;
  }

  const data = event.data ?? {};
  const invoiceId = data.invoice_id ?? data.id;
  const orderId = data.order_id;

  if (!invoiceId || !orderId) {
    logger.warn(
      `[PAY-REBIND] event missing invoice_id or order_id: ${JSON.stringify(data)}`
    );
    return;
  }

  const financeService = container.resolve(FINANCE_MODULE);
  const invoiceService = container.resolve(INVOICE_MODULE);
  const query = container.resolve("query");

  // 1. Find dangling order-only applications (non-voided, no invoice yet).
  const dangling = await financeService
    .listPaymentApplications({ order_id: orderId, invoice_id: null })
    .catch(() => [] as any[]);
  const active = dangling.filter((a: any) => !a.voided_at);

  if (active.length === 0) return;

  // 2. Fetch the new PosInvoice + Medusa order + sibling invoices for prorate.
  const invoice = await invoiceService
    .retrievePosInvoice(invoiceId)
    .catch(() => null);
  if (!invoice) {
    logger.warn(`[PAY-REBIND] invoice ${invoiceId} not retrievable — abort`);
    return;
  }

  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: ["id", "total"],
    filters: { id: orderId },
  });

  const orderTotalCents = order ? getNum(order.total) : 0;
  const invoiceTotalCents = getNum((invoice as any).total);

  const siblingInvoices = await invoiceService
    .listPosInvoices({ order_id: orderId }, { take: 1000 })
    .catch(() => [] as any[]);
  const otherInvoicesTotal = siblingInvoices
    .filter(
      (inv: any) => inv.id !== invoiceId && inv.status !== "voided"
    )
    .reduce((sum: number, inv: any) => sum + getNum(inv.total), 0);

  const ratio = computeProrateRatio({
    invoiceTotalCents,
    orderTotalCents,
    otherInvoicesTotalCents: otherInvoicesTotal,
  });

  // 3. Prorate each dangling application.
  let boundCount = 0;
  let splitCount = 0;
  for (const app of active) {
    const appAmount = getNum(app.amount_applied);
    const share = computeProrateShare(appAmount, ratio);
    if (share <= 0) continue;

    if (share >= appAmount) {
      await financeService.updatePaymentApplications({
        id: app.id,
        invoice_id: invoiceId,
        invoice_number: String((invoice as any).invoice_number ?? ""),
      });
      boundCount++;
    } else {
      await financeService.createPaymentApplications({
        payment_id: app.payment_id,
        invoice_id: invoiceId,
        invoice_number: String((invoice as any).invoice_number ?? ""),
        order_id: app.order_id,
        amount_applied: share,
        applied_at: new Date(),
        applied_by: "system:rebind",
        metadata: {
          source: "rebind",
          from_application_id: app.id,
          ratio,
        },
      });
      await financeService.updatePaymentApplications({
        id: app.id,
        amount_applied: appAmount - share,
      });
      splitCount++;
    }
  }

  logger.info(
    `[PAY-REBIND] order=${orderId} invoice=${invoiceId} ratio=${ratio.toFixed(
      3
    )} dangling=${active.length} bound=${boundCount} split=${splitCount}`
  );
}

export const config: SubscriberConfig = {
  event: "pos.invoice.created",
};
