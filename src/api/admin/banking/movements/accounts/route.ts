import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listMovementAccounts } from "../../../../../lib/banking/movement-source";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankFailure } from "../../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { await reviewAccess(req); return res.json(await listMovementAccounts()); }
  catch (error) { return bankFailure(res, error); }
}
