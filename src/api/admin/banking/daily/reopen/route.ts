import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { dailyReopenSchema, reopenDailyReview } from "../../../../../lib/banking/review-daily";
import { bankBody, bankFailure } from "../../_lib/http";

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { actorId } = await reviewAccess(req, "close");
    const key = req.headers["idempotency-key"];
    return res.json(await reopenDailyReview(actorId, typeof key === "string" ? key : undefined, bankBody(dailyReopenSchema, req.body)));
  } catch (error) { return bankFailure(res, error); }
}
