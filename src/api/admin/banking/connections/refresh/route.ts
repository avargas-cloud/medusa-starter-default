import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { refreshBanks } from "../../../../../lib/banking/actions";
import { bankAccess } from "../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../lib/banking/security";
import { guardSupervisorPin } from "../../../../../lib/pos/supervisor-pin-guard";
import { bankBody, bankFailure, bankId } from "../../_lib/http";
import { pinGuardFailure, pinGuardInput } from "../../_lib/pin";

const refreshBody = z.object({ connection_ids: z.array(bankId).min(1).max(10) });

/**
 * "Request update": the operator picks banks in a modal and confirms with the supervisor
 * PIN; each selected bank costs one billed Plaid /transactions/refresh. The PIN is verified
 * ONCE here for the whole batch — one authorization, not N attempts against the throttle.
 * Replaces POST /connections/:id/refresh, which never asked for a PIN.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await bankAccess(req, true);
    requireBankingEnabled();
    // El permiso dice QUIÉN puede administrar; el PIN autoriza el GASTO.
    const guard = await guardSupervisorPin(pinGuardInput(req));
    if (!guard.ok) return pinGuardFailure(res, guard);
    const body = bankBody(refreshBody, req.body);
    return res.status(202).json(await refreshBanks(body.connection_ids));
  } catch (error) {
    return bankFailure(res, error);
  }
}
