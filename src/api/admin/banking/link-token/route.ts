import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { bankAccess } from "../../../../lib/banking/auth";
import { requireBankingSandbox } from "../../../../lib/banking/security";
import { createLinkToken } from "../../../../lib/banking/connections";
import { bankBody, bankFailure, bankId } from "../_lib/http";

const bodySchema = z.object({ connection_id: bankId.optional() });

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { actorId } = await bankAccess(req, true);
    requireBankingSandbox();
    const body = bankBody(bodySchema, req.body ?? {});
    return res.json(await createLinkToken(actorId, body.connection_id));
  } catch (error) { return bankFailure(res, error); }
}
