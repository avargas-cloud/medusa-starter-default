import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { voidJournalEntry } from "../../../../../../lib/ledger";
import {
  REASON_SCHEMA,
  invalidBody,
  ledgerFailure,
} from "../../../../../../lib/ledger/documents/manual-http";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../../utils/db-pool";

/**
 * POST /admin/accounting/journal-entries/:id/void { reason }
 *   Reversa el asiento (si estaba posteado) y deja el documento `voided`.
 *   → 200 { journal_entry } · 409 GL_DOCUMENT_NOT_POSTED (ya anulado) · 409 GL_PERIOD_CLOSED
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
  const parsed = REASON_SCHEMA.safeParse(req.body);
  if (!parsed.success)
    return invalidBody(
      res,
      parsed.error.issues[0]?.message ?? "reason is required"
    );

  const client: PoolClient = await getDbPool().connect();
  try {
    const journalEntry = await voidJournalEntry(
      client,
      req.params.id as string,
      parsed.data.reason,
      actorId
    );
    return res.json({ journal_entry: journalEntry });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
