import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";

import { pgLinkDb, unlinkByDocument } from "../../../../../../lib/calendar/occurrence-link";
import { voidBankTransfer } from "../../../../../../lib/ledger";
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
 * POST /admin/accounting/transfers/:id/void { reason }
 *   Reversa el asiento (si estaba posteado) y deja el documento `voided`.
 *   → 200 { transfer } · 409 GL_DOCUMENT_NOT_POSTED (ya anulado) · 409 GL_PERIOD_CLOSED
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
    const transfer = await voidBankTransfer(
      client,
      req.params.id as string,
      parsed.data.reason,
      actorId,
      {
        // La ocurrencia del calendario que esta transferencia liquidaba vuelve a
        // `expected` (misma transacción; sólo si seguía booked con ESTE documento).
        inTransaction: async (tx, id) => {
          const doc = await tx.query<{ doc_number: string }>(`SELECT doc_number FROM gl_transfer WHERE id = $1`, [id]);
          await unlinkByDocument(pgLinkDb(tx), "gl_transfer", id, `${doc.rows[0]?.doc_number ?? "Transfer"} voided`);
        },
      }
    );
    return res.json({ transfer });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
