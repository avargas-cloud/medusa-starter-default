import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { readDailyReview } from "../../../../lib/banking/review-daily-read";
import { reviewDate } from "../../../../lib/banking/review-date";
import { bankBody, bankFailure } from "../_lib/http";

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const access = await reviewAccess(req);
    const result = await readDailyReview(bankBody(reviewDate, req.query.date));
    return res.json({ ...result, can_close: result.can_close && access.canClose });
  } catch (error) { return bankFailure(res, error); }
}
