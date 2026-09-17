import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { REASON_SCHEMA } from "../../../../../../../lib/ledger/documents/manual-http";
import { voidSalesTaxPayment } from "../../../../../../../lib/ledger/documents/sales-tax-payment";

import { invalid, withAccountingAndPin } from "../../../_lib/common";

/** POST /admin/accounting/sales-tax/payments/:id/void (PIN) { reason } → { payment } — reversa + TxnVoid SalesTaxPaymentCheck; libera los STA aplicados. */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = REASON_SCHEMA.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "reason is required");
  await withAccountingAndPin(req, res, async (client, actorId) => {
    res.json({ payment: await voidSalesTaxPayment(client, req.params.id as string, parsed.data.reason, actorId) });
  });
}
