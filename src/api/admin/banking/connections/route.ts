import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { bankAccess } from "../../../../lib/banking/auth";
import { requireBankingSandbox } from "../../../../lib/banking/security";
import { connectBank } from "../../../../lib/banking/connections";
import { bankBody, bankFailure } from "../_lib/http";

const bodySchema = z.object({ public_token: z.string().min(1).max(512) });

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { actorId } = await bankAccess(req, true);
    requireBankingSandbox();
    const body = bankBody(bodySchema, req.body);
    return res.json(await connectBank(body.public_token, actorId));
  } catch (error) { return bankFailure(res, error); }
}
