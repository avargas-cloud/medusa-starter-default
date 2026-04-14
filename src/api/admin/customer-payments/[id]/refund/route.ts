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
    const alreadyApplied = activeApps.reduce(
      (s: number, a: any) => s + Number(a.amount_applied ?? 0),
      0
    );
    const alreadyRefunded = Number(
      (payment as any).metadata?.refund_amount ?? 0
    );
    const available = Math.max(
      0,
      Number(payment.amount) - alreadyApplied - alreadyRefunded
    );

    const refundAmount = amount ?? available;

    if (refundAmount <= 0)
      return res.status(400).json({ error: "No available balance to refund" });
    if (refundAmount > available) {
      return res.status(400).json({
        error: `Refund amount (${refundAmount}) exceeds available balance (${available})`,
      });
    }

    const isFullRefund = refundAmount >= available;
    const newStatus = isFullRefund ? "refunded" : "partial_refunded";

    const existingMeta = (payment as any).metadata ?? {};
    const refundMeta = {
      ...existingMeta,
      refund_amount: alreadyRefunded + refundAmount,
      refunded_at: new Date().toISOString(),
      refund_notes: notes ?? null,
      refunded_by: voided_by ?? null,
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
