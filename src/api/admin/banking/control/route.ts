import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { bankAccess } from "../../../../lib/banking/auth";
import {
  readBankingControl,
  setBankingControl,
} from "../../../../lib/banking/control";
import { requireBankingEnabled } from "../../../../lib/banking/security";
import { bankBody, bankFailure } from "../_lib/http";

const bodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).max(500).nullable().optional(),
});

/** Kill switch. Reading needs banking access; flipping it is an administrator action recorded with actor and reason. */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await bankAccess(req, false);
    requireBankingEnabled();
    return res.json({ control: await readBankingControl() });
  } catch (error) {
    return bankFailure(res, error);
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId } = await bankAccess(req, true);
    requireBankingEnabled();
    const body = bankBody(bodySchema, req.body);
    return res.json({
      control: await setBankingControl(
        actorId,
        body.enabled,
        body.reason ?? null
      ),
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
