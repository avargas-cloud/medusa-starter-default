import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { getDbPool } from "../../../../../utils/db-pool";
import { qbImportVoidSchema, voidQbImportDocument } from "../../../../../../lib/ledger/qb-import/void";
import { invalidBody, ledgerFailure } from "../../../../../../lib/ledger/documents/manual-http";
import { accessFailure, assertAccounting } from "../../../../../../lib/pos/access-level";

/**
 * POST /admin/accounting/ledger/qb-import/void — "Void & redo" of a document
 * imported from QuickBooks (`qb_import:<TxnID>`), from the Bank Feed Correct
 * modal or the Register (qb-import-void-ui-20260915).
 *   { txn_id, reason }
 *   → 201 { txn_id, entry_id, reversal_entry_id, day, qb: { queued, pipeline_row_id | reason } }
 *   400 GL_SOURCE_INVALID { reason: not_imported | already_reversed | type_not_voidable (txn_type) |
 *       entry_matched (match_id, statement_id, statement_status) | statement_closed (day) }
 *   409 GL_PERIOD_CLOSED (Month Close)
 * A rejection writes nothing: the reversal and the pipeline row share one transaction.
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
  const parsed = qbImportVoidSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);
  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await voidQbImportDocument(client, parsed.data, actorId);
    return res.status(201).json(result);
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
