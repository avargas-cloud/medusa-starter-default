import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { fileSalesTaxReturn } from "../../../../../../../lib/sales-tax/returns";

import { CENTS_SCHEMA, invalid, periodParam, withAccounting } from "../../../_lib/common";

const BODY = z.object({
  confirmation_number: z.string().trim().min(1).max(80),
  filed_amount_cents: CENTS_SCHEMA,
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** POST /admin/accounting/sales-tax/periods/:period/file { confirmation_number, filed_amount_cents, notes? } → { return } */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = periodParam(req, res);
  if (!period) return;
  const parsed = BODY.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message);
  await withAccounting(req, res, async (client, actorId) => {
    res.json({ return: await fileSalesTaxReturn(client, period, parsed.data, actorId) });
  });
}
