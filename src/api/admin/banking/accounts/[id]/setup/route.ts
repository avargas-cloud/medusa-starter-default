import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { accountSetupSchema, saveAccountSetup } from "../../../../../../lib/banking/review-setup";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { actorId } = await reviewAccess(req, "manage");
    const key = req.headers["idempotency-key"];
    return res.json(await saveAccountSetup(actorId, bankBody(bankId, req.params.id),
      typeof key === "string" ? key : undefined, bankBody(accountSetupSchema, req.body)));
  } catch (error) { return bankFailure(res, error); }
}
