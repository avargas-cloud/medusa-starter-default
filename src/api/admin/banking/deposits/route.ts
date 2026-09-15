import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { saveBankDeposit } from "../../../../lib/banking/deposit-core";
import { listBankDeposits } from "../../../../lib/banking/deposit-read";
import { depositSaveSchema } from "../../../../lib/banking/deposit-types";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../_lib/http";
import { reviewKey } from "../_lib/review-http";
const query = z.object({
  /** Plaid account id, or the QuickBooks ListID of a deposit-to account with no feed. */
  account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  q: z.string().max(200).optional(),
  status: z.enum(["draft", "ready", "void"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await listBankDeposits(bankBody(query, req.query)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "review");
    return res.json(
      await saveBankDeposit(
        actorId,
        reviewKey(req),
        bankBody(depositSaveSchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
