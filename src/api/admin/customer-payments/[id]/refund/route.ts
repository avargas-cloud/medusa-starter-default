/**
 * POST /admin/customer-payments/:id/refund
 * Refund a payment (full or partial).
 * Body: { amount?: number, notes?: string, voided_by?: string }
 *
 * Updates the original payment directly — no second record created.
 * Stores refund info in metadata and reduces available_balance.
 * Status: 'refunded' (full) or 'partial_refunded' (partial).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { assertWebOrdersAuthorized } from "../../../orders/[id]/_lib/assert-web-order-authorized";
import { FINANCE_MODULE } from "../../../../../modules/finance";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const { amount, notes, voided_by } = req.body as {
    amount?: number;
    notes?: string;
    voided_by?: string;
  };

  const financeService = req.scope.resolve(FINANCE_MODULE);

  try {
    const payment = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (["voided", "refunded"].includes(payment.status as string)) {
      return res
        .status(400)
        .json({ error: `Payment is already ${payment.status}` });
    }

    const activeApps = ((payment as any).applications ?? []).filter(
      (a: any) => !a.voided_at
    );

    // Refund de plata atada a una orden WEB → PIN de supervisor. El pago se
    // atribuye por locked_order_id / metadata.order_id / applications — si
    // CUALQUIERA de esas órdenes vino de la web, devolver su dinero es una
    // edición del contrato del cliente. Corre ANTES de toda mutación.
    const webGate = await assertWebOrdersAuthorized(
      req.scope,
      [
        (payment as any).locked_order_id as string | undefined,
        (payment as any).metadata?.order_id as string | undefined,
        ...activeApps.map((a: any) => a.order_id as string | undefined),
      ],
      req
    );
    if (webGate.denial) {
      return res.status(webGate.denial.status).json(webGate.denial.body);
    }

    // Invoice-bound applications are consumed money (immutable here).
    // Order-only rows (invoice_id NULL) are reversible RESERVATIONS from
    // "Link to Order" — refundable: the refund releases them (same hard-delete
    // semantics as the unlink route; they never touch invoices or QB).
    const invoiceApplied = activeApps
      .filter((a: any) => !!a.invoice_id)
      .reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0);
    const orderOnlyApps = activeApps.filter((a: any) => !a.invoice_id);
    const reserved = orderOnlyApps.reduce(
      (s: number, a: any) => s + Number(a.amount_applied ?? 0),
      0
    );
    const alreadyRefunded = Number(
      (payment as any).metadata?.refund_amount ?? 0
    );
    const available = Math.max(
      0,
      Number(payment.amount) - invoiceApplied - reserved - alreadyRefunded
    );
    const refundable = available + reserved;

    const refundAmount = amount ?? refundable;

    if (refundAmount <= 0)
      return res.status(400).json({ error: "No refundable balance" });
    if (refundAmount > refundable) {
      return res.status(400).json({
        error: `Refund amount (${refundAmount}) exceeds refundable balance (${refundable})`,
      });
    }

    // Free balance is consumed first; anything beyond it comes out of the
    // order-only reservations, which must be released (delete/decrement).
    let needFromReserved = Math.max(0, refundAmount - available);
    const releasedApps: Array<Record<string, unknown>> = [];
    if (needFromReserved > 0) {
      if ((payment as any).source === "web") {
        return res.status(403).json({
          error:
            "Refund exceeds free balance and the remainder is reserved on a web payment — web payment links are immutable. Unlink is not allowed.",
        });
      }
      const ordered = [...orderOnlyApps].sort(
        (a: any, b: any) =>
          new Date(a.applied_at ?? 0).getTime() -
          new Date(b.applied_at ?? 0).getTime()
      );
      for (const app of ordered) {
        if (needFromReserved <= 0) break;
        const appAmt = Number(app.amount_applied ?? 0);
        if (appAmt <= needFromReserved) {
          await financeService.deletePaymentApplications([app.id]);
          releasedApps.push({
            id: app.id,
            order_id: app.order_id ?? null,
            released: appAmt,
          });
          needFromReserved -= appAmt;
        } else {
          await financeService.updatePaymentApplications({
            id: app.id,
            amount_applied: appAmt - needFromReserved,
          });
          releasedApps.push({
            id: app.id,
            order_id: app.order_id ?? null,
            released: needFromReserved,
            partial: true,
          });
          needFromReserved = 0;
        }
      }
    }

    const isFullRefund = refundAmount >= refundable;
    const newStatus = isFullRefund ? "refunded" : "partial_refunded";

    const existingMeta = (payment as any).metadata ?? {};
    const refundMeta = {
      ...existingMeta,
      refund_amount: alreadyRefunded + refundAmount,
      refunded_at: new Date().toISOString(),
      refund_notes: notes ?? null,
      refunded_by: voided_by ?? null,
      ...(releasedApps.length > 0
        ? {
            refund_released_applications: [
              ...((existingMeta.refund_released_applications as
                | unknown[]
                | undefined) ?? []),
              ...releasedApps,
            ],
          }
        : {}),
    };

    const pgConnection = req.scope.resolve("__pg_connection__") as any;
    await pgConnection.raw(
      `UPDATE customer_payment
             SET status = ?,
                 metadata = ?::jsonb
             WHERE id = ?`,
      [newStatus, JSON.stringify(refundMeta), id]
    );

    const updated = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
    return res.json({
      payment: updated,
      refunded: refundAmount,
      full_refund: isFullRefund,
    });
  } catch (err: any) {
    console.error("[refund route]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
