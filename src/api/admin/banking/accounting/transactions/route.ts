import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { listAccountingTransactions } from "../../../../../lib/banking/accounting-read";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { reviewDate } from "../../../../../lib/banking/review-date";
import { bankBody, bankFailure, bankId } from "../../_lib/http";
const filters = z.object({ account_id: bankId.optional(), from: reviewDate.optional(), to: reviewDate.optional(),
  offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({ ...await listAccountingTransactions(bankBody(filters, req.query)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}

