import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// 1.5.9: handlePosPaymentApplied import removed — apply route enqueues now.
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../../modules/invoices";
import { getDbPool } from "../../../../../utils/db-pool";
import {
  getAppliedInvoiceTotal,
  getNum,
} from "../../../../invoices/payment-balance";
import { matchesLinkIntent } from "../../../../../../lib/finance/upsert-order-only-application";
import { reconcileOrderReservations } from "../../../../../../lib/finance/reconcile-order-reservations";
import { registerMedusaPayment } from "../../../../invoices/register-medusa-payment";
import { handleOrderApply } from "./handle-order-apply";
import { refreshOrderDocsForPayment } from "../../../_lib/refresh-order-docs";
import {
  createRoundingWriteOff,
  getLiveRoundingWriteOffCents,
} from "../../../../../../lib/rounding/create-write-off";
import { createOverageWriteOff } from "../../../../../../lib/rounding/overage";
import { getBusinessDateString } from "../../../../../../lib/quickbooks/order-flow-core";

/**
 * POST /admin/finance/payments/:id/apply
 * Applies an available CustomerPayment to a specific PosInvoice OR Medusa Order.
 *
 * Payload (one of invoice_id | order_id required):
 *   { invoice_id, amount_applied, applied_by }  → applies to a PosInvoice (full flow:
 *       creates PaymentApplication, InvoicePayment, updates PosInvoice, enqueues QB).
 *   { order_id, amount_applied, applied_by }    → applies as a deposit on a Medusa Order
 *       (no invoice yet). Creates PaymentApplication with invoice_id=NULL. Auto-rebind
 *       to the PosInvoice happens later via the payment-application-rebind subscriber.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const paymentId = req.params.id!;
  const { invoice_id, order_id, amount_applied, applied_by, link_intent_key } =
    req.body as any;

  if (!invoice_id && !order_id) {
    return res
      .status(400)
      .json({ error: "Either invoice_id or order_id is required" });
  }
  if (invoice_id && order_id) {
    return res.status(400).json({
      error:
        "Provide either invoice_id OR order_id, not both. Submit two requests to apply to both.",
    });
  }
  if (!amount_applied || amount_applied <= 0) {
    return res
      .status(400)
      .json({ error: "amount_applied must be a positive number" });
  }

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const invoiceService = req.scope.resolve(INVOICE_MODULE);

  try {
    // 1. Fetch the CustomerPayment with its current applications
    const payment = await financeService.retrieveCustomerPayment(paymentId, {
      relations: ["applications"],
    });

    if (!payment) {
      return res.status(404).json({ error: "Customer payment not found" });
    }

    if (payment.status === "voided") {
      return res.status(400).json({ error: "Cannot apply a voided payment" });
    }

    if (payment.source === "web") {
      return res.status(403).json({
        error:
          "Web checkout payments are automatically applied to their source orders and cannot be manually applied.",
      });
    }

    // Idempotency guard (Link-credit double-click / network retry). When the
    // caller supplies a link_intent_key, a replay returns the application that
    // was already created for that intent instead of minting a second one.
    // PURELY ADDITIVE — requests without the key behave exactly as before.
    if (link_intent_key) {
      // matchesLinkIntent also checks the `link_intent_keys` object map that
      // the order-only UPSERT records when a second link merges into an
      // existing reservation — a replay of THAT intent must be caught too.
      const existing = (payment.applications ?? []).find(
        (a: any) => !a.voided_at && matchesLinkIntent(a.metadata, link_intent_key)
      );
      if (existing) {
        const refetched = await financeService.retrieveCustomerPayment(
          paymentId,
          { relations: ["applications"] }
        );
        const invoiceBound = (refetched.applications ?? [])
          .filter((a: any) => !a.voided_at && a.invoice_id != null)
          .reduce((s: number, a: any) => s + getNum(a.amount_applied), 0);
        return res.json({
          payment: refetched,
          application: existing,
          requested_amount: Number(amount_applied),
          applied_amount: getNum(existing.amount_applied),
          overflow_amount: 0,
          remaining_payment_balance: Math.max(
            0,
            getNum(payment.amount) - invoiceBound
          ),
          idempotent_replay: true,
        });
      }
    }

    // Two notions of "applied":
    //  • invoice-bound applications are REAL consumption (settled into an invoice)
    //  • order-only applications are convertible reservations, NOT consumption
    // A deposit fully reserved against its order (every deposit, post-refactor)
    // is still 100% spendable toward that order's invoice — it gets CONVERTED
    // (see CONVERT-ON-APPLY below), not stacked. So order-only rows must NOT
    // reduce the balance available to apply onto an invoice; otherwise a
    // fully-reserved deposit shows 0 available and the apply is rejected.
    const invoiceBoundApplied = payment.applications
      .filter((app: any) => !app.voided_at && app.invoice_id != null)
      .reduce((sum: number, app: any) => sum + getNum(app.amount_applied), 0);

    const totalReserved = payment.applications
      .filter((app: any) => !app.voided_at)
      .reduce((sum: number, app: any) => sum + getNum(app.amount_applied), 0);

    // Order-only branch: delegate to helper and short-circuit. Returns the
    // same response shape as the invoice branch. Reserving MORE deposit can't
    // exceed what's already reserved, so this branch guards against the full
    // total (order-only + invoice-bound).
    if (order_id && !invoice_id) {
      const reserveAvailable = getNum(payment.amount) - totalReserved;
      if (reserveAvailable <= 0) {
        return res.status(400).json({
          error: "This payment has no available balance to reserve.",
        });
      }
      return handleOrderApply(
        {
          scope: req.scope,
          payment,
          order_id,
          amount_applied,
          applied_by: applied_by ?? null,
          available_amount: reserveAvailable,
          total_applied: totalReserved,
          link_intent_key: link_intent_key ?? null,
        },
        res
      );
    }

    // Settling onto an invoice: order-only reservations are convertible, so only
    // invoice-bound consumption reduces what's available to apply.
    const availableAmount = getNum(payment.amount) - invoiceBoundApplied;

    if (availableAmount <= 0) {
      return res.status(400).json({
        error: "This payment has no available balance to apply.",
      });
    }

    // 2. Fetch the target invoice to get order_id and ensure it exists
    const invoice = await invoiceService.retrievePosInvoice(invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: "Target invoice not found" });
    }
    if (invoice.status === "voided") {
      return res
        .status(400)
        .json({ error: "Cannot apply payment to a voided invoice" });
    }

    // Auto-clamp the requested amount: never apply more than what the invoice still owes,
    // and never more than what the deposit has available. Anything left over stays on the
    // CustomerPayment as available credit for future invoices.
    const invoiceTotal = getNum((invoice as any).total);
    const invoiceAmountPaid = await getAppliedInvoiceTotal(
      req.scope,
      invoice_id
    );
    // Un ajuste de redondeo ya emitido cubre esos centavos: sin restarlos acá,
    // este clamp deja pasar plata real contra un residuo YA absorbido, y el
    // mismo centavo queda cobrado dos veces. Es el MISMO invariante que el
    // recálculo de más abajo, y por eso se resta en los dos lugares — el E2E
    // encontró primero uno y después el otro.
    const invoiceWrittenOff = await getLiveRoundingWriteOffCents(
      req.scope,
      invoice_id
    );
    const invoiceBalanceDue = Math.max(
      0,
      invoiceTotal - invoiceAmountPaid - invoiceWrittenOff
    );

    if (invoiceBalanceDue <= 0) {
      return res.status(400).json({
        error: "Invoice is already paid in full — no balance to apply.",
      });
    }

    const requestedAmount = Number(amount_applied);
    const effectiveAmount = Math.min(
      requestedAmount,
      invoiceBalanceDue,
      availableAmount
    );
    const overflowAmount = requestedAmount - effectiveAmount;

    // 3. Bind the payment to the invoice.
    //    If this payment already carries an ORDER-ONLY application (invoice_id
    //    NULL) for THIS invoice's order — e.g. a deposit captured against the
    //    order — CONVERT it to invoice-bound instead of creating a second row.
    //    Creating a new row would leave two non-voided applications (order-only
    //    + invoice-bound) for the same cash, double-counting it in Treasury.
    //    Converting preserves the frozen cost_snapshot captured at deposit time.
    const orderOnlyForOrder = (payment.applications ?? []).find(
      (a: any) =>
        !a.voided_at &&
        (a.invoice_id === null || a.invoice_id === undefined) &&
        a.order_id === invoice.order_id
    );

    let application: any;
    // Every invoice-bound application created/converted in this request
    // (normally one, but the full-convert + surplus case below produces TWO
    // with DIFFERENT amounts). The QB enqueue must emit one papp_ pipeline row
    // PER application with its real amount — a single row carrying the total
    // under the first application's id desyncs the consolidator's resubmit
    // (which re-reads amount_applied from the row's application) and leaves
    // the surplus application invisible to papp_ keying. Mirrors the
    // boundApplications pattern in admin/invoices/route.ts.
    const boundApplications: Array<{ id: string; amount: number }> = [];
    if (orderOnlyForOrder) {
      const existingAmount = getNum(orderOnlyForOrder.amount_applied);
      const convertAmount = Math.min(effectiveAmount, existingAmount);

      if (convertAmount >= existingAmount) {
        // Convert the whole order-only reservation to invoice-bound.
        application = await financeService.updatePaymentApplications({
          id: orderOnlyForOrder.id,
          invoice_id: invoice_id,
          invoice_number: String((invoice as any).invoice_number || ""),
          ...(link_intent_key
            ? {
                metadata: {
                  ...(orderOnlyForOrder.metadata || {}),
                  link_intent_key,
                },
              }
            : {}),
        });
        boundApplications.push({ id: application.id, amount: existingAmount });
      } else {
        // Partial: peel off an invoice-bound share, keep the remainder order-only.
        application = await financeService.createPaymentApplications({
          payment_id: paymentId,
          invoice_id: invoice_id,
          invoice_number: String((invoice as any).invoice_number || ""),
          order_id: invoice.order_id,
          amount_applied: convertAmount,
          applied_at: new Date(),
          applied_by: applied_by || null,
          cost_snapshot: orderOnlyForOrder.cost_snapshot ?? null,
          ...(link_intent_key ? { metadata: { link_intent_key } } : {}),
        });
        boundApplications.push({ id: application.id, amount: convertAmount });
        await financeService.updatePaymentApplications({
          id: orderOnlyForOrder.id,
          amount_applied: existingAmount - convertAmount,
        });
      }

      // If the cashier applied MORE than the existing reservation covered, the
      // surplus becomes a fresh invoice-bound application (extra credit on the
      // same payment beyond the order-only reservation).
      const surplus = effectiveAmount - convertAmount;
      if (surplus > 0) {
        const surplusApplication =
          await financeService.createPaymentApplications({
            payment_id: paymentId,
            invoice_id: invoice_id,
            invoice_number: String((invoice as any).invoice_number || ""),
            order_id: invoice.order_id,
            amount_applied: surplus,
            applied_at: new Date(),
            applied_by: applied_by || null,
          });
        boundApplications.push({ id: surplusApplication.id, amount: surplus });
      }
    } else {
      // No existing reservation — create the invoice-bound application directly.
      application = await financeService.createPaymentApplications({
        payment_id: paymentId,
        invoice_id: invoice_id,
        invoice_number: String((invoice as any).invoice_number || ""),
        order_id: invoice.order_id,
        amount_applied: effectiveAmount,
        applied_at: new Date(),
        applied_by: applied_by || null,
        ...(link_intent_key ? { metadata: { link_intent_key } } : {}),
      });
      boundApplications.push({ id: application.id, amount: effectiveAmount });
    }

    // 4. Update the CustomerPayment status
    // effectiveAmount is the amount now invoice-bound (freshly created or
    // converted from an order-only reservation), so add it to prior invoice-bound
    // consumption only — never to the order-only row it may have just converted,
    // which would double-count and wrongly flip status to "applied".
    const isFullyApplied =
      invoiceBoundApplied + effectiveAmount >= getNum(payment.amount);
    const newPaymentStatus = isFullyApplied ? "applied" : "partially_applied";

    await financeService.updateCustomerPayments({
      id: paymentId,
      status: newPaymentStatus,
    });

    // 5. Create the corresponding InvoicePayment in the Invoice module
    await invoiceService.createInvoicePayments({
      invoice_id: invoice_id,
      amount: effectiveAmount,
      payment_method: "credit", // In the context of the invoice, the method is "customer credit"
      notes: `Applied from deposit/payment ${payment.reference || paymentId}`,
      created_by: applied_by || null,
      paid_at: new Date(),
    });

    // 6. Recalculate invoice totals and status
    const totalInvoicePaid = await getAppliedInvoiceTotal(
      req.scope,
      invoice_id
    );
    // MISMO `invoiceWrittenOff` del clamp de arriba, a propósito: son la misma
    // pregunta ("¿cuánto de esta factura ya se absorbió?") y computarla dos
    // veces es exactamente cómo los dos lugares vuelven a divergir. Ningún
    // ajuste se emite entre ambos puntos, así que el valor sigue vigente.
    const rawBalanceDue = Math.max(
      0,
      getNum(invoice.total) - totalInvoicePaid - invoiceWrittenOff
    );

    // Residuo de redondeo: una orden facturada en partes deja centavos abiertos
    // que nadie va a pagar, porque el tax se redondea una vez POR FACTURA
    // (`Σ round(baseᵢ × tasa) ≠ round(Σ baseᵢ × tasa)`) mientras el pago se
    // cobró con la convención de la orden entera. Absorberlo NO edita la
    // factura —sigue siendo el snapshot inmutable que era— sino que registra
    // CÓMO se saldó, con tope, actor y motivo.
    //
    // Lo que venía pasando en su lugar: conciliar a mano creando un pago de un
    // centavo que el cliente nunca hizo, o sea plata inventada en su cuenta
    // corriente. Un ajuste rotulado es estrictamente mejor que eso.
    const writeOff = await createRoundingWriteOff(req.scope, {
      invoiceId: invoice_id,
      invoiceNumber: (invoice as any).invoice_number ?? invoice_id,
      orderId: invoice.order_id ?? null,
      balanceDueCents: rawBalanceDue,
      actor: applied_by || null,
    });

    const balanceDue = writeOff.created ? 0 : rawBalanceDue;
    const newInvoiceStatus = balanceDue <= 0 ? "paid" : "partial";

    // Backfill pos_invoice.payment_method on the FIRST applied payment when
    // the invoice was created via Skip Payment (payment_method left null).
    // The underlying customer_payment carries the actual method (cash/check/...);
    // for cards we pull the brand off the payment's metadata.
    const invoiceMethodBackfill =
      !(invoice as any).payment_method && (payment as any).method
        ? {
            payment_method: (payment as any).method,
            card_brand:
              ((payment as any).metadata?.card_brand as string | undefined) ??
              null,
          }
        : {};

    await invoiceService.updatePosInvoices({
      id: invoice_id,
      amount_paid: totalInvoicePaid,
      balance_due: balanceDue,
      status: newInvoiceStatus,
      ...invoiceMethodBackfill,
    });

    // 6b. Overage — la dirección ESPEJO, y se evalúa RECIÉN ACÁ.
    //
    // El sobrante no pertenece a ninguna factura: pertenece al pago. Y sólo se
    // puede diagnosticar DESPUÉS de saldar esta factura, porque antes "sobra
    // plata" es indistinguible de "todavía falta facturar" — absorberlo ahí
    // sería quedarse con un adelanto del cliente.
    //
    // `decideOverage` exige las tres condiciones (remanente ≤ tope · orden
    // totalmente facturada · ninguna factura debiendo). El caso normal, de
    // lejos, es que no haga nada.
    const overage = await createOverageWriteOff(req.scope, {
      paymentId,
      paymentRef: (payment as any).display_id ?? paymentId,
      actor: applied_by || null,
      // Fecha del negocio, nunca el reloj de la PC donde corre QuickBooks.
      businessDate: getBusinessDateString(),
    });
    if (overage.created) {
      await financeService
        .updateCustomerPayments({ id: paymentId, status: "applied" })
        .catch(() => {}); // no-fatal: la fila del ajuste ya es la verdad
    }

    // 7. Register in Medusa native Payment Module (best-effort, every payment)
    if (invoice.order_id) {
      const medusaPaymentId = await registerMedusaPayment(req.scope, {
        order_id: invoice.order_id,
        amount: effectiveAmount,
        payment_method: payment.method,
        invoice_total: getNum(invoice.total),
        customer_payment_id: payment.id,
      });
      if (medusaPaymentId) {
        await financeService
          .updateCustomerPayments({
            id: paymentId,
            medusa_payment_synced: true,
          })
          .catch(() => {}); // non-fatal
      }
    }

    // Reservation hygiene: settling onto the invoice raised invoice-bound
    // consumption — release any order-only remainder that now exceeds what
    // the order still needs reserved. Non-fatal.
    if (invoice.order_id) {
      try {
        await reconcileOrderReservations(req.scope, invoice.order_id, {
          logger: req.scope.resolve("logger"),
        });
      } catch {
        /* non-fatal */
      }
    }

    // Refetch updated payment for response
    const updatedPayment = await financeService.retrieveCustomerPayment(
      paymentId,
      {
        relations: ["applications"],
      }
    );

    // 8. Write upfront apply_payment pipeline row + fire QB sync via direct exec (bypass BullMQ)
    if (process.env.QB_ORDER_FLOW_ENABLED === "true" && invoice.order_id) {
      // Look up the payment's display_id for the medusa ref
      let applyMedusaRef: string | null = null;
      try {
        const payForRef =
          await financeService.retrieveCustomerPayment(paymentId);
        if ((payForRef as any).display_id) {
          applyMedusaRef = `PAY-${(payForRef as any).display_id}`;
        }
      } catch {}

      // Look up invoice pipeline row to set dependsOn
      let invoicePipelineRowId: string | null = null;
      try {
        const pool = getDbPool();
        const { rows: invRows } = await pool.query(
          `SELECT id FROM qb_order_pipeline
                     WHERE order_id = $1 AND step = 'invoice' AND reference_id = $2
                     ORDER BY created_at DESC LIMIT 1`,
          [invoice.order_id, invoice_id]
        );
        invoicePipelineRowId = invRows[0]?.id ?? null;
      } catch {}

      // One waiting + pending row PER bound application (split-safe): the
      // waiting write gives instant UI visibility with the invoice dependency;
      // the pending write flips the same row (writePipelineRow dedups by
      // order_id+step+reference_id) into dispatchable state. Do NOT collapse
      // this into a single `pending` write with dependsOn — the pending
      // dispatch pass claims by status alone and ignores depends_on; the
      // handler itself requeues to waiting-with-dependency when TxnIDs are
      // missing, which is what actually gates dispatch order.
      for (const bound of boundApplications) {
        // Upfront waiting row — gives instant UI visibility before handler runs
        try {
          await writePipelineRow({
            orderId: invoice.order_id,
            referenceId: bound.id,
            referenceType: "payment_application",
            step: "apply_payment",
            status: "waiting",
            dependsOn: invoicePipelineRowId,
            medusaRefNumber: applyMedusaRef,
          });
        } catch (rowErr: any) {
          req.scope
            .resolve("logger")
            .warn(
              `[apply] Could not write upfront pipeline row: ${rowErr.message}`
            );
        }

        // 1.5.9: pipeline-only — enqueue 'apply_payment' for consolidator pickup.
        try {
          const {
            writePipelineRow: enqueueApplyFin,
          } = require("../../../../../../lib/quickbooks/qb-pipeline");
          await enqueueApplyFin({
            orderId: invoice.order_id ?? null,
            referenceId: bound.id,
            referenceType: "payment_application",
            step: "apply_payment",
            status: "pending",
            payload: {
              payment_id: paymentId,
              invoice_id,
              order_id: invoice.order_id,
              amount_applied: bound.amount,
              application_id: bound.id,
            },
          });
        } catch (execErr: any) {
          req.scope
            .resolve("logger")
            .error(
              `[apply] Enqueue apply_payment failed: ${execErr.message}`
            );
        }
      }
    }

    // The order's paid amount just changed, so its search doc is now stale:
    // effective_payment and is_unpaid are computed at index time. Never fatal.
    await refreshOrderDocsForPayment(req.scope, paymentId);

    return res.json({
      payment: updatedPayment,
      application,
      requested_amount: requestedAmount,
      applied_amount: effectiveAmount,
      overflow_amount: overflowAmount,
      remaining_payment_balance: availableAmount - effectiveAmount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
