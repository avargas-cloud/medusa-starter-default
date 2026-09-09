import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reconnectBank } from "../../../../../../lib/banking/actions";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../../lib/banking/security";
import { guardSupervisorPin } from "../../../../../../lib/pos/supervisor-pin-guard";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { pinGuardFailure, pinGuardInput } from "../../../_lib/pin";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await bankAccess(req, true);
    requireBankingEnabled();
    // El permiso dice QUIÉN puede administrar; el PIN autoriza el CAMBIO.
    const guard = await guardSupervisorPin(pinGuardInput(req));
    if (!guard.ok) return pinGuardFailure(res, guard);
    return res.json(await reconnectBank(bankBody(bankId, req.params.id)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
