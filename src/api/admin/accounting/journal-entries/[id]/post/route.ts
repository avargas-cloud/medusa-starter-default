import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import {
  getJournalEntry,
  postJournalEntry,
} from "../../../../../../lib/ledger";
import { ledgerFailure } from "../../../../../../lib/ledger/documents/manual-http";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../../utils/db-pool";

/**
 * POST /admin/accounting/journal-entries/:id/post
 *   → 201 { status: "posted", entry_id, journal_entry } · 200 { status: "already_posted", … }
 *   409 GL_DOCUMENT_NOT_DRAFT (voided) · 409 GL_PERIOD_CLOSED · 400 GL_SOURCE_INVALID
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
  const client: PoolClient = await getDbPool().connect();
  try {
    const id = req.params.id as string;
    const result = await postJournalEntry(client, id, actorId);
    const journalEntry = await getJournalEntry(client, id);
    return res
      .status(result.status === "posted" ? 201 : 200)
      .json({ ...result, journal_entry: journalEntry });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
