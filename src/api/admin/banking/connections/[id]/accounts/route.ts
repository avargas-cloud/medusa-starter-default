import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { selectBankAccounts } from "../../../../../../lib/banking/actions";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../../lib/banking/security";
import { guardSupervisorPin } from "../../../../../../lib/pos/supervisor-pin-guard";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { pinGuardFailure, pinGuardInput } from "../../../_lib/pin";

const bodySchema = z.object({
  account_ids: z
    .array(bankId)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});

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
    return res.json(await selectBankAccounts(id, body.account_ids));
  } catch (error) {
    return bankFailure(res, error);
  }
}
