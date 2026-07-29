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
import { buildOrderCostSnapshot } from "../../../../../../lib/finance/build-order-cost-snapshot";
import { computeOrderReservationState } from "../../../../../../lib/finance/reconcile-order-reservations";
import { upsertOrderOnlyApplication } from "../../../../../../lib/finance/upsert-order-only-application";
import { registerMedusaPayment } from "../../../../invoices/register-medusa-payment";
import { getNum } from "../../../../invoices/payment-balance";
import { refreshOrderDocsForPayment } from "../../../_lib/refresh-order-docs";

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
  /** Idempotency key for Link-credit double-click/retry (optional, additive). */
  link_intent_key?: string | null;
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
    link_intent_key,
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
  // archived = POS-closed order (toggle-close on a partially-invoiced order).
  // The open-orders picker already hides these; this keeps direct API calls
  // consistent — reopen the order first if a deposit really must attach.
  if (
    orderStatus === "draft" ||
    orderStatus === "canceled" ||
    orderStatus === "archived"
  ) {
    return res.status(400).json({
      error: `Cannot apply payment to ${orderStatus === "archived" ? "an" : "a"} ${orderStatus} order`,
    });
  }

  // 2. Auto-clamp against BOTH the payment's available balance AND the
  //    order's outstanding balance ("el POS order define el monto linkeado").
  //    POLICY CHANGE 2026-07-16: over-linking beyond the order total is no
  //    longer allowed — prepay-larger-than-order now stays in the payment's
  //    AVAILABLE pool (still consumable), and the POS offers to link it via
  //    the Cover-with-Credit prompt if the order grows. When the order total
  //    is unresolvable (total_unknown) the order-cap fails OPEN.
  const requestedAmount = Number(amount_applied);
  let orderCap = Number.POSITIVE_INFINITY;
  try {
    const state = await computeOrderReservationState(scope, order_id);
    if (state && !state.total_unknown) {
      orderCap = state.gap_cents; // allowed − already-linked
    }
  } catch {
    /* fail-open: order cap is hygiene; available_amount still caps below */
  }
  if (orderCap <= 0 && Number.isFinite(orderCap)) {
    return res.status(400).json({
      error:
        "The order's balance is already fully covered by linked credit — nothing left to link.",
      code: "ORDER_BALANCE_FULLY_LINKED",
    });
  }
  const effectiveAmount = Math.min(requestedAmount, available_amount, orderCap);
  const overflowAmount = requestedAmount - effectiveAmount;

  // 3. Create PaymentApplication with invoice_id=NULL (order-only link).
  //    Freeze the per-line cost basis now so Treasury's order-only COGS for the
  //    cash day doesn't drift when POs are received later. Best-effort: a
  //    snapshot failure must not block recording the deposit.
  let costSnapshot: Awaited<ReturnType<typeof buildOrderCostSnapshot>> | null =
    null;
  try {
    const pg = scope.resolve("__pg_connection__") as Parameters<
      typeof buildOrderCostSnapshot
    >[0];
    costSnapshot = await buildOrderCostSnapshot(pg, order_id);
  } catch {
    costSnapshot = null;
  }

  // UPSERT (not blind create): at most ONE active order-only row per
  // (payment, order) — enforced by UQ_payment_application_order_only_active.
  // A second legitimate link to the same order INCREMENTS the existing
  // reservation; a replayed link_intent_key is a no-op.
  const upsert = await upsertOrderOnlyApplication({
    financeService,
    knex: scope.resolve("__pg_connection__"),
    payment_id: payment.id,
    order_id,
    amount_cents: effectiveAmount,
    applied_by: applied_by || null,
    cost_snapshot: costSnapshot,
    link_intent_key: link_intent_key ?? null,
  });
  const application = upsert.application;

  if (upsert.mode === "replayed") {
    // Same intent already recorded — belt-and-suspenders behind the route's
    // replay check. Skip Medusa payment registration (the original call did it).
    const replayedPayment = await financeService.retrieveCustomerPayment(
      payment.id,
      { relations: ["applications"] }
    );
    // Refreshed on the replay too: the refresh is non-fatal, so if the original
    // call's attempt failed this is the natural retry.
    await refreshOrderDocsForPayment(scope, payment.id);

    return res.json({
      payment: replayedPayment,
      application,
      requested_amount: requestedAmount,
      applied_amount: getNum(application.amount_applied),
      overflow_amount: 0,
      remaining_payment_balance: available_amount,
      linked_to: "order",
      idempotent_replay: true,
    });
  }

  // 4. Do NOT change customer_payment.status for an order-only link.
  //    Business rule: "applied" / "partially_applied" reflect consumption by
  //    INVOICES only. Order-only applications reserve credit but the payment
  //    keeps its prior status (typically 'available'). The status will flip
  //    later when the PosInvoice is generated and the rebind subscriber
  //    converts the application to invoice-bound.
  void total_applied; // intentionally unused — kept for signature stability

  // 5. Register in Medusa native Payment Module so the order shows the deposit.
  //    Non-fatal — Finance Ledger remains the source of truth.
  // order.total is DOLLARS (Medusa BigNumber) → ×100; registerMedusaPayment
  // expects invoice_total in CENTS.
  const orderTotalCents = getNum(order.total) * 100;
  const medusaPaymentId = await registerMedusaPayment(scope, {
    order_id,
    amount: effectiveAmount,
    payment_method: payment.method,
    invoice_total: orderTotalCents,
    customer_payment_id: payment.id,
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

  // The order's deposit just changed, so its search doc is stale:
  // effective_payment and is_unpaid are computed at index time. This is THE path
  // that matters — a deposit on an order comes through here, and the route's own
  // refresh never runs for it because this helper returns first. Never fatal.
  await refreshOrderDocsForPayment(scope, payment.id);

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
