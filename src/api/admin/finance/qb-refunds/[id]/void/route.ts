import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { voidCheckInQb } from "../../../../../../lib/quickbooks/client/checks";
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";

/**
 * POST /admin/finance/qb-refunds/:id/void
 *
 * Voids a pending refund:
 *  - If the QB Write Check has been confirmed (qb.status === 'yes'), voids it in QB.
 *  - Always marks the CustomerPayment status as 'voided'.
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

  // If the check was confirmed in QB, void it there first
  if (qb?.status === "yes" && checkTxnId) {
    const result = await voidCheckInQb(checkTxnId);

    if (!result.success) {
      return res.status(500).json({
        error: `Failed to void check in QuickBooks: ${result.error}`,
      });
    }

    await writePipelineRow({
      referenceId: id,
      referenceType: "customer_payment",
      step: "void_check",
      status: "submitted",
      bridgeOpId: result.data?.operationId ?? null,
      qbTxnId: checkTxnId,
    }).catch(() => {});
  }

  // Mark CustomerPayment as voided
  await financeService.updateCustomerPayments(
    { id },
    {
      status: "voided",
      qb: { ...(qb ?? {}), status: "voided" },
    }
  );

  return res.json({
    success: true,
    voided: true,
    check_txn_id: checkTxnId ?? null,
  });
};
