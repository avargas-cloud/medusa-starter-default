import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { listMovementSources } from "../../../../../lib/banking/movement-source";
import { movementSourceKinds } from "../../../../../lib/banking/movement-types";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
const query = z.object({
  kind: z.enum(movementSourceKinds),
  q: z.string().max(160).default(""),
});
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    const input = bankBody(query, req.query);
    return res.json(await listMovementSources(input.kind, input.q));
  } catch (error) {
    return bankFailure(res, error);
  }
}
