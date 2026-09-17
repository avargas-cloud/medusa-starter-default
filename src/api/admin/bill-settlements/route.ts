import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../lib/accounting/month-close-auth";
import { bankingErrorResponse } from "../../../lib/accounting/banking-error-http";
import { runLedgerHook } from "../../../lib/ledger-hooks/run-ledger-hook";
import { settleBills } from "../../../lib/bill-settlements/settle";
import { BillSettlementError, type SettleBillsInput } from "../../../lib/bill-settlements/types";
import type { SqlClient } from "../../../lib/accounting/month-close-data";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

/**
 * POST { vendor_id, settlement_date, credit_allocations[], prepayment_allocations[], cash? }
 * Orchestrates Pay Bills' three lanes in order (credits → prepayments →
 * cash). The steps already posted travel back in the body even on failure —
 * this is not a rollback, they are real documents — so the POS can show the
 * operator exactly how far a settlement got.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const body = req.body as Omit<SettleBillsInput, "actor_id">;

  let result;
  try {
    result = await settleBills(
      {
        pool: getDbPool(),
        knex: req.scope.resolve("__pg_connection__") as SqlClient,
        runLedgerHook,
      },
      { ...body, actor_id: actorId }
    );
  } catch (error) {
    if (error instanceof BillSettlementError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  }

  if (result.ok) {
    return res.status(201).json({ settlement: result });
  }
  return res.status(result.failed!.status).json({
    error: result.failed!.message,
    code: result.failed!.code,
    settlement: result,
  });
}
