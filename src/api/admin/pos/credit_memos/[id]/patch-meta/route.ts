import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// 1.5.8: updateCreditMemoInQb import removed — patch-meta enqueues credit_memo_mod now.
import { parseSalesRepInitials } from "../../../../../../lib/quickbooks/parse-sales-rep";
import { getQbConfig } from "../../../../../../lib/quickbooks/qb-config";
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";

/**
 * PATCH /admin/pos/credit_memos/:id/patch-meta
 *
 * Lightweight partial update for completed credit memos.
 * Only updates sales_rep and/or tax fields without touching items.
 *
 * When tax_mode changes:
 *   1. Validates that the new lower total doesn't undercut already-applied credit.
 *   2. Updates the linked customer_payment amount to match.
 *
 * Body: {
 *   sales_rep?: { initials: string; name: string } | null
 *   tax_mode?:  'florida' | 'exempt'
 *   subtotal?:  number  (cents — required when tax_mode is provided to recalculate tax)
 * }
 */
export async function PATCH(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const { sales_rep, tax_mode, subtotal } = (req.body ?? {}) as {
    sales_rep?: { initials: string; name: string } | null;
    tax_mode?: "florida" | "exempt";
    subtotal?: number;
  };

  if (sales_rep === undefined && tax_mode === undefined) {
    res
      .status(400)
      .json({ error: "Provide at least one of: sales_rep, tax_mode" });
    return;
  }

  if (
    tax_mode !== undefined &&
    tax_mode !== "florida" &&
    tax_mode !== "exempt"
  ) {
    res.status(400).json({ error: "tax_mode must be 'florida' or 'exempt'" });
    return;
  }

  const creditMemoService =
    req.scope.resolve<CreditMemoModuleService>(CREDIT_MEMO_MODULE);
  const pgConnection = req.scope.resolve("__pg_connection__") as any;

  const [memo] = await (creditMemoService as any)
    .listPosCreditMemos({ id: [id] })
    .catch(() => []);

  if (!memo) {
    res.status(404).json({ error: `Credit memo ${id} not found` });
    return;
  }

  const update: Record<string, unknown> = {};

  if (sales_rep !== undefined) {
    update.sales_rep = sales_rep;
  }

  if (tax_mode !== undefined) {
    const sub = subtotal ?? (memo as any).subtotal ?? 0;
    const newTax = tax_mode === "florida" ? Math.round(Number(sub) * 0.07) : 0;
    const newTotal = Number(sub) + newTax + Number((memo as any).shipping ?? 0);

    // ── Payment guard: cannot reduce below already-applied credit ────────────
    const cmNumber = (memo as any).credit_memo_number as
      | string
      | null
      | undefined;
    if (cmNumber) {
      const payment = await pgConnection("customer_payment")
        .where({ reference: cmNumber, type: "credit_memo" })
        .whereNull("deleted_at")
        .first()
        .catch(() => null);

      if (payment) {
        const applyRow = await pgConnection("payment_application")
          .where({ payment_id: payment.id })
          .whereNull("voided_at")
          .whereNull("deleted_at")
          .sum("amount_applied as total")
          .first()
          .catch(() => null);

        const appliedTotal = Number(applyRow?.total ?? 0);

        if (newTotal < appliedTotal) {
          const appliedDollars = (appliedTotal / 100).toFixed(2);
          res.status(409).json({
            error: `Cannot reduce credit: $${appliedDollars} has already been applied to invoices. Reverse those applications first.`,
          });
          return;
        }

        // Update payment amount to reflect new total
        await pgConnection("customer_payment")
          .where({ id: payment.id })
          .update({
            amount: newTotal,
            raw_amount: JSON.stringify({
              value: String(newTotal),
              precision: 20,
            }),
            updated_at: new Date(),
          });
      }
    }

    update.tax = newTax;
    update.total = newTotal;
  }

  await (creditMemoService as any).updatePosCreditMemos({ id, ...update });

  // ── QB Mod — fire-and-forget pipeline entry if this CM is synced to QB ──────
  const qbTxnId = (memo as any).qb_txn_id as string | null | undefined;
  // 1.5.8: qb_edit_sequence is now read by the consolidator (case
  // 'credit_memo_mod') from pos_credit_memo via JOIN. No longer needed here.
  const cmNumber = (memo as any).credit_memo_number as
    | string
    | null
    | undefined;

  if (qbTxnId && process.env.QB_ORDER_FLOW_ENABLED === "true") {
    const salesRepRef =
      sales_rep !== undefined ? parseSalesRepInitials(sales_rep) : undefined;
    const isFlorida = tax_mode === "florida";
    const isExempt = tax_mode === "exempt";

    writePipelineRow({
      referenceId: id,
      referenceType: "credit_memo",
      step: "credit_memo_mod",
      status: "pending",
      medusaRefNumber: cmNumber ?? null,
      qbTxnId,
    })
      .then(async () => {
        // 1.5.8: pipeline-only — enqueue 'credit_memo_mod' with mod fields
        // in payload. Consolidator's case (added in 1.5.1.5) joins with
        // pos_credit_memo for qb_txn_id + qb_edit_sequence and submits.
        const qbConfig = isFlorida ? await getQbConfig() : null;
        return writePipelineRow({
          referenceId: id,
          referenceType: "credit_memo",
          step: "credit_memo_mod",
          status: "pending",
          medusaRefNumber: cmNumber ?? null,
          qbTxnId,
          payload: {
            ...(salesRepRef !== undefined ? { salesRepRef } : {}),
            ...(isFlorida && qbConfig
              ? { salesTaxCode: qbConfig.defaultSalesTaxCode }
              : {}),
            ...(isExempt ? { taxExempt: true } : {}),
          },
        });
      })
      .catch((err: Error) => {
        console.error(
          `[patch-meta] QB credit_memo_mod pipeline error for ${id}:`,
          err.message
        );
        writePipelineRow({
          referenceId: id,
          referenceType: "credit_memo",
          step: "credit_memo_mod",
          status: "failed",
          medusaRefNumber: cmNumber ?? null,
          qbTxnId,
          error: err.message,
        }).catch(() => {});
      });
  }

  res.status(200).json({ success: true });
}
