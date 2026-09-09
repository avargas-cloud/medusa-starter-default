import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { z } from "zod";

import {
  reviewAccess,
  type ReviewCapability,
} from "../../../../lib/banking/review-permissions";
import { BankingError } from "../../../../lib/banking/security";

import { bankBody, bankId } from "./http";

export const reviewVersions = z.object({
  expected_revision: z.number().int().min(0).max(2147483647),
  expected_source_version: z.number().int().positive().max(2147483647),
});
export const lookupQuery = z.object({ q: z.string().max(200).default("") });
export function reviewKey(req: AuthenticatedMedusaRequest): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
    throw new BankingError("BANKING_IDEMPOTENCY_KEY_REQUIRED");
  }
  return key;
}
export async function reviewCommandRequest(
  req: AuthenticatedMedusaRequest,
  capability: ReviewCapability = "review"
): Promise<
  Awaited<ReturnType<typeof reviewAccess>> & { id: string; key: string }
> {
  const access = await reviewAccess(req, capability);
  return {
    ...access,
    id: bankBody(bankId, req.params.id),
    key: reviewKey(req),
  };
}
