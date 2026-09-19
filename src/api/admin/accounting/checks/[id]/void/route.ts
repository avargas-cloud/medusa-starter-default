import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { refreshSuggestionsForDocument } from "../../../../../../lib/banking/suggestion-refresh-document";
import { pgLinkDb, unlinkByDocument } from "../../../../../../lib/calendar/occurrence-link";
import { voidBankCheck } from "../../../../../../lib/ledger";
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
 * POST /admin/accounting/checks/:id/void { reason }
 *   Reversa el asiento (si estaba posteado) y deja el documento `voided`. Si el
 *   check liquidaba una ocurrencia del Accounting Calendar, ésta vuelve a
 *   `expected` en la misma transacción (sólo si seguía `booked` con ESTE check).
 *   → 200 { check } · 409 GL_DOCUMENT_NOT_POSTED (ya anulado) · 409 GL_PERIOD_CLOSED
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
    const check = await voidBankCheck(
      client,
      req.params.id as string,
      parsed.data.reason,
      actorId,
      {
        inTransaction: async (tx, id) => {
          const doc = await tx.query<{ doc_number: string }>(`SELECT doc_number FROM gl_check WHERE id = $1`, [id]);
          await unlinkByDocument(pgLinkDb(tx), "gl_check", id, `${doc.rows[0]?.doc_number ?? "Check"} voided`);
        },
      }
    );
    await refreshSuggestionsForDocument(getDbPool(), req.params.id as string, actorId);
    return res.json({ check });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
