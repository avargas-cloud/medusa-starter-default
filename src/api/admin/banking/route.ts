import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../lib/banking/review-permissions";
import { bankingOverview } from "../../../lib/banking/views";

import { bankFailure } from "./_lib/http";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canManage, canReview, canClose, canPost } = await reviewAccess(req);
    const overview = await bankingOverview(canManage, canReview, canClose);
    // `can_post` gates Confirm-with-category in the feed (creates a document → ledger + QuickBooks),
    // bank-feed-suggestions-20260915. The store-pos type already declared it optional.
    return res.json({ ...overview, config: { ...overview.config, can_post: canPost } });
  } catch (error) {
    return bankFailure(res, error);
  }
}
