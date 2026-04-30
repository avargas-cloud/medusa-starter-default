import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../../modules/finance";

/**
 * POST /admin/finance/qb-refunds/:id/void
 *
 * Voids a pending refund:
 *  - If the QB Write Check has been confirmed (qb.status === 'yes'), enqueues
 *    a void_check pipeline row; the consolidator will call QB.
 *  - Always marks the CustomerPayment status as 'voided'.
 *
 * Section 1.5.14: enqueue-only — no direct bridge call. UI should poll the
 * pipeline row for confirmation.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id as string;
  const financeService = req.scope.resolve(FINANCE_MODULE);

  const payments = await financeService.listCustomerPayments({ id } as any);
  const payment = (payments as any[])[0];

  if (!payment) {
    return res.status(404).json({ error: "CustomerPayment not found" });
  }
  const isRefundable =
    payment.type === "refund" ||
    (payment.type !== "refund" &&
      ["refunded", "partial_refunded"].includes(payment.status));
  if (!isRefundable) {
    return res.status(400).json({ error: "Payment is not a refund" });
  }
  if (payment.status === "voided") {
    return res.status(400).json({ error: "Refund is already voided" });
  }

  const qb = payment.qb as Record<string, any> | null;
  const checkTxnId = qb?.check_txn_id as string | undefined;

  let queued = false;
  if (qb?.status === "yes" && checkTxnId) {
    await writePipelineRow({
      referenceId: id,
      referenceType: "customer_payment",
      step: "void_check",
      status: "pending",
      qbTxnId: checkTxnId,
    });
    queued = true;
  }

  await financeService.updateCustomerPayments(
    { id },
    {
      status: "voided",
      qb: { ...(qb ?? {}), status: "voided" },
    }
  );

  return res.status(queued ? 202 : 200).json({
    success: true,
    voided: true,
    queued,
    check_txn_id: checkTxnId ?? null,
  });
};
