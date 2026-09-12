import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  createReadyDepositFromPayment,
  depositFromPaymentSchema,
} from "../../../../../lib/banking/deposit-from-payment";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
import { reviewKey } from "../../_lib/review-http";

/** One receipt → one READY deposit (bank-feed matcher and "Deposit one receipt"). */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "review");
    return res.json(
      await createReadyDepositFromPayment(
        actorId,
        reviewKey(req),
        bankBody(depositFromPaymentSchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
