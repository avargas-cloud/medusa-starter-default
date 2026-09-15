import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { getDbPool } from "../../../../utils/db-pool";
import { reclassifyMatch, reclassifySchema } from "../../../../../lib/banking/reclassification";
import { invalidBody, ledgerFailure } from "../../../../../lib/ledger/documents/manual-http";
import { accessFailure, assertAccounting } from "../../../../../lib/pos/access-level";

/**
 * POST /admin/accounting/journal-entries/reclassify — "Corregir" on a Reconciled
 * Bank Feed row (bankfeed-correct-20260915, policy rule 3).
 *   { match_id, counter_line_id, to_account_list_id, amount_cents, day?, memo? }
 *   → 201 { journal_entry (posted, corrects_* set), entry_id }
 *   400 GL_SOURCE_INVALID { reason: statement_not_closed | counter_line_not_in_entry |
 *       counter_line_is_bank | target_account_is_bank | same_account | day_before_2026 |
 *       amount_exceeds_reclassifiable (reclassifiable_cents) | account_not_active }
 *   404 GL_DOCUMENT_NOT_FOUND (match) · 409 GL_PERIOD_CLOSED (Month Close)
 * A rejection writes nothing; a refused post deletes its own draft.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = reclassifySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);
  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await reclassifyMatch(client, parsed.data, actorId);
    return res.status(201).json(result);
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
