import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import {
  previewReopenChain,
  reopenStatementChain,
} from "../../../../../../lib/banking/statement-reopen-chain";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";

/**
 * GET  → the plan: which later statements and Month Closes reopen with this one.
 * POST → reopen them all (newest first) in one transaction. Both need the close
 * permission (2026-09-15).
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req, "close");
    return res.json({
      chain: await previewReopenChain(bankBody(bankId, req.params.id)),
      can_review: access.canReview,
      can_close: access.canClose,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewCommandRequest(req, "close");
    return res.json({
      ...(await reopenStatementChain(
        access.id,
        access.actorId,
        access.key,
        req.body
      )),
      can_review: access.canReview,
      can_close: access.canClose,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
