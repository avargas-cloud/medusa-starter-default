import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../../../lib/accounting/month-close-auth";
import { LedgerError, reverseOpeningBalance } from "../../../../../../../lib/ledger";
import { getDbPool } from "../../../../../../utils/db-pool";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  throw error;
}

function ledgerErrorStatus(code: LedgerError["code"]): number {
  if (code === "GL_ALREADY_POSTED" || code === "GL_PERIOD_CLOSED") return 409;
  if (code === "GL_UNBALANCED_DOCUMENT") return 500;
  return 400;
}

interface OpeningBalanceReverseParams extends Record<string, string> {
  accountListId: string;
}

const bodySchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

/**
 * POST /admin/accounting/ledger/opening-balances/:accountListId/reverse
 *
 * Reversa el OBE activo de la cuenta. Motivo obligatorio; idempotente.
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

  const { accountListId } = req.params as OpeningBalanceReverseParams;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "reason is required",
      code: "invalid_body",
    });
  }

  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await reverseOpeningBalance(
      client,
      accountListId,
      parsed.data.reason,
      actorId
    );
    if (result.status === "nothing_to_reverse") {
      return res.status(404).json({
        error: "No active opening balance posted for this account",
        code: "GL_NOT_POSTED",
      });
    }
    if (result.status === "already_reversed") {
      return res.status(409).json({
        error: "Opening balance already reversed",
        code: "GL_ALREADY_REVERSED",
        entry_id: result.entry_id,
      });
    }
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof LedgerError) {
      return res.status(ledgerErrorStatus(error.code)).json({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}
