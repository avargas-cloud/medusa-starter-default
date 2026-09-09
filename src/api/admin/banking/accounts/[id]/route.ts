import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { mapBankAccount } from "../../../../../lib/banking/actions";
import { bankAccess } from "../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../lib/banking/security";
import { guardSupervisorPin } from "../../../../../lib/pos/supervisor-pin-guard";
import { bankBody, bankFailure, bankId } from "../../_lib/http";
import { pinGuardFailure, pinGuardInput } from "../../_lib/pin";

const bodySchema = z.object({ qb_list_id: bankId.nullable() });

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
    const id = bankBody(bankId, req.params.id);
    const body = bankBody(bodySchema, req.body);
    return res.json(await mapBankAccount(id, body.qb_list_id));
  } catch (error) {
    return bankFailure(res, error);
  }
}
