import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { prepareSalesTaxReturn } from "../../../../../../../lib/sales-tax/returns";
import { loadSalesTaxSettings } from "../../../../../../../lib/sales-tax/settings";

import { invalid, periodParam, withAccounting } from "../../../_lib/common";

const BODY = z.object({ notes: z.string().trim().max(2000).nullable().optional() });

/** POST /admin/accounting/sales-tax/periods/:period/prepare { notes? } → 201 { return, summary } · 409 si ya estaba preparada */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = periodParam(req, res);
  if (!period) return;
  const parsed = BODY.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message);
  await withAccounting(req, res, async (client, actorId) => {
    const settings = await loadSalesTaxSettings(client);
    const result = await prepareSalesTaxReturn(client, settings, period, actorId, parsed.data.notes ?? null);
    res.status(201).json(result);
  });
}
