import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { reopenSalesTaxReturn } from "../../../../../../../lib/sales-tax/returns";

import { periodParam, withAccountingAndPin } from "../../../_lib/common";

/** POST /admin/accounting/sales-tax/periods/:period/reopen (PIN) → { removed } — la declaración vuelve a `open`. */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = periodParam(req, res);
  if (!period) return;
  await withAccountingAndPin(req, res, async (client) => {
    res.json(await reopenSalesTaxReturn(client, period));
  });
}
