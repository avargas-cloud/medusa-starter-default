import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { ZodError } from "zod";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../../lib/accounting/month-close-auth";
import {
  addOpeningBalanceEvidence,
  LedgerAttachmentError,
} from "../../../../../../lib/ledger/opening-evidence";
import { getDbPool } from "../../../../../utils/db-pool";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  throw error;
}

/**
 * POST /admin/accounting/ledger/opening-balances/evidence
 *
 * Sube el PDF de evidencia de un OBE a `bank_opening_evidence` — la misma
 * tabla de Banking v10, dueño semántico nuevo. `{ name, mime_type, content_base64 }`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const client: PoolClient = await getDbPool().connect();
  try {
    const evidence = await addOpeningBalanceEvidence(
      client,
      actorId,
      req.body as { name: string; mime_type: "application/pdf"; content_base64: string }
    );
    return res.status(201).json({ evidence });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: error.issues[0]?.message ?? "Invalid body",
        code: "invalid_body",
      });
    }
    if (error instanceof LedgerAttachmentError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}
