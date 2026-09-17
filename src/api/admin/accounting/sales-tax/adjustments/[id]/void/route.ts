import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { REASON_SCHEMA } from "../../../../../../../lib/ledger/documents/manual-http";
import { voidSalesTaxAdjustment } from "../../../../../../../lib/ledger/documents/sales-tax-adjustment";

import { invalid, withAccountingAndPin } from "../../../_lib/common";

/** POST /admin/accounting/sales-tax/adjustments/:id/void (PIN) { reason } → { adjustment } · 409 adjustment_applied si un pago vivo lo usa. */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = REASON_SCHEMA.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "reason is required");
  await withAccountingAndPin(req, res, async (client, actorId) => {
    res.json({ adjustment: await voidSalesTaxAdjustment(client, req.params.id as string, parsed.data.reason, actorId) });
  });
}
