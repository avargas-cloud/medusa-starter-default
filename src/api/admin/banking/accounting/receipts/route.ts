import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { listReceiptAccounting } from "../../../../../lib/banking/receipts-read";
import { reviewDate } from "../../../../../lib/banking/review-date";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
const filters = z
  .object({
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    from: reviewDate.optional(),
    to: reviewDate.optional(),
  })
  .strict();
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({
      ...(await listReceiptAccounting("receipt", bankBody(filters, req.query))),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
