import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../lib/banking/review-permissions";
import {
  listReviewRules,
  ruleSaveSchema,
  saveReviewRule,
} from "../../../../lib/banking/review-rules";
import { bankBody, bankFailure } from "../_lib/http";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await listReviewRules());
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
    const key = req.headers["idempotency-key"];
    return res.json(
      await saveReviewRule(
        actorId,
        typeof key === "string" ? key : undefined,
        bankBody(ruleSaveSchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
