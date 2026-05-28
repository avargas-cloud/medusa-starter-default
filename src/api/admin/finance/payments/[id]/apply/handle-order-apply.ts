/**
 * handle-order-apply.ts
 *
 * Handles applying a CustomerPayment directly to a Medusa Order (not a PosInvoice).
 * Used when a customer pays a deposit for an order that has not yet been invoiced.
 *
 * The resulting PaymentApplication has invoice_id=NULL. When the PosInvoice is
 * eventually generated for this order, the payment-application-rebind subscriber
 * populates invoice_id (prorating across multiple invoices if applicable).
 *
 * QB Bridge: order-only applications (invoice_id IS NULL) are intentionally NOT
 * enqueued into the QB pipeline here — they wait for the rebind to populate
 * invoice_id. See P6 in payments-treasury-refactor-scope.
 */
import type { MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { registerMedusaPayment } from "../../../../invoices/register-medusa-payment";
import { getNum } from "../../../../invoices/payment-balance";

export interface OrderApplyOpts {
  scope: { resolve: (key: string) => any };
  payment: {
    id: string;
    amount: unknown;
    method: string;
    status: string;
    source: string;
  };
  order_id: string;
  amount_applied: number;
  applied_by: string | null;
  available_amount: number;
  total_applied: number;
}

const QUERY_KEY = "query";

export async function handleOrderApply(
  opts: OrderApplyOpts,
  res: MedusaResponse
) {
  const {
    scope,
    payment,
    order_id,
    amount_applied,
    applied_by,
    available_amount,
    total_applied,
  } = opts;

  if (!order_id) {
    return res.status(400).json({ error: "order_id is required" });
  }
  if (!amount_applied || amount_applied <= 0) {
    return res
      .status(400)
      .json({ error: "amount_applied must be a positive number" });
  }

  const query = scope.resolve(QUERY_KEY);
  const financeService = scope.resolve(FINANCE_MODULE);

  // 1. Validate Medusa order exists, is non-draft, and non-canceled.
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: ["id", "status", "total", "currency_code"],
    filters: { id: order_id },
  });

  if (!order) {
    return res.status(404).json({ error: "Medusa order not found" });
  }

  const orderStatus = String(order.status ?? "").toLowerCase();
  if (orderStatus === "draft" || orderStatus === "canceled") {
    return res.status(400).json({
      error: `Cannot apply payment to a ${orderStatus} order`,
    });
  }

  // 2. Auto-clamp against payment available balance. We intentionally do NOT
  //    clamp against order outstanding balance — staff may apply more than the
  //    order's listed total if upselling or partial-prepay scenarios apply.
  //    Surplus over the order will simply remain in available_amount when this
  //    is the only allocation.
  const requestedAmount = Number(amount_applied);
  const effectiveAmount = Math.min(requestedAmount, available_amount);
  const overflowAmount = requestedAmount - effectiveAmount;

  // 3. Create PaymentApplication with invoice_id=NULL (order-only link).
  const application = await financeService.createPaymentApplications({
    payment_id: payment.id,
    invoice_id: null,
    invoice_number: null,
    order_id,
    amount_applied: effectiveAmount,
    applied_at: new Date(),
    applied_by: applied_by || null,
  });

  // 4. Do NOT change customer_payment.status for an order-only link.
  //    Business rule: "applied" / "partially_applied" reflect consumption by
  //    INVOICES only. Order-only applications reserve credit but the payment
  //    keeps its prior status (typically 'available'). The status will flip
  //    later when the PosInvoice is generated and the rebind subscriber
  //    converts the application to invoice-bound.
  void total_applied; // intentionally unused — kept for signature stability

  // 5. Register in Medusa native Payment Module so the order shows the deposit.
  //    Non-fatal — Finance Ledger remains the source of truth.
  const orderTotalCents = getNum(order.total);
  const medusaPaymentId = await registerMedusaPayment(scope, {
    order_id,
    amount: effectiveAmount,
    payment_method: payment.method,
    invoice_total: orderTotalCents,
  });
  if (medusaPaymentId) {
    await financeService
      .updateCustomerPayments({
        id: payment.id,
        medusa_payment_synced: true,
      })
      .catch(() => {});
  }

  // 6. NO InvoicePayment, NO PosInvoice update, NO QB pipeline enqueue.
  //    These happen at rebind time when the PosInvoice is created.

  const updatedPayment = await financeService.retrieveCustomerPayment(
    payment.id,
    { relations: ["applications"] }
  );

  return res.json({
    payment: updatedPayment,
    application,
    requested_amount: requestedAmount,
    applied_amount: effectiveAmount,
    overflow_amount: overflowAmount,
    remaining_payment_balance: available_amount - effectiveAmount,
    linked_to: "order",
  });
}
