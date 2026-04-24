import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";

/**
 * PATCH /admin/pos/credit_memos/:id/patch-meta
 *
 * Lightweight partial update for completed credit memos.
 * Only updates sales_rep and/or tax fields without touching items.
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
    res.status(400).json({ error: "Provide at least one of: sales_rep, tax_mode" });
    return;
  }

  if (tax_mode !== undefined && tax_mode !== "florida" && tax_mode !== "exempt") {
    res.status(400).json({ error: "tax_mode must be 'florida' or 'exempt'" });
    return;
  }

  const creditMemoService = req.scope.resolve<CreditMemoModuleService>(CREDIT_MEMO_MODULE);

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
    update.tax = newTax;
    update.total = newTotal;
  }

  await (creditMemoService as any).updatePosCreditMemos({ id, ...update });

  res.status(200).json({ success: true });
}
