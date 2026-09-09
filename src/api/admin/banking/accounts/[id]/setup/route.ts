import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import {
  accountSetupSchema,
  saveAccountSetup,
} from "../../../../../../lib/banking/review-setup";
import { guardSupervisorPin } from "../../../../../../lib/pos/supervisor-pin-guard";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { pinGuardFailure, pinGuardInput } from "../../../_lib/pin";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "manage");
    // El permiso dice QUIÉN puede administrar; el PIN autoriza el CAMBIO.
    const guard = await guardSupervisorPin(pinGuardInput(req));
    if (!guard.ok) return pinGuardFailure(res, guard);
    const key = req.headers["idempotency-key"];
    return res.json(
      await saveAccountSetup(
        actorId,
        bankBody(bankId, req.params.id),
        typeof key === "string" ? key : undefined,
        bankBody(accountSetupSchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
