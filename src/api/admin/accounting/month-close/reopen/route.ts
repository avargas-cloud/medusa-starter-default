import {
  withBankAccountingMonthLock,
  type TransactionalAccountingDb,
} from "../../../../../lib/accounting/banking-period-lock";

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { parseMonth } from "../../../../../lib/accounting/month-close-data";
import { reopenClosedMonth } from "../../../../../lib/accounting/month-close-reopen";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const body = req.body as {
    month?: string;
    input_hash?: string;
    reason?: string;
  };
  const range = parseMonth(body.month);
  if (!range || !body.input_hash || !body.reason?.trim()) {
    return res.status(400).json({
      error: "month, input_hash and reason are required",
      code: "invalid_reopen_request",
    });
  }
  const reason = body.reason.trim();
  const inputHash = body.input_hash;
  const baseDb = req.scope.resolve(
    "__pg_connection__"
  ) as TransactionalAccountingDb;
  // Same rules as before the extraction (2026-09-15): the reopen chain of bank
  // statements reuses `reopenClosedMonth` from its own transaction.
  const result = await withBankAccountingMonthLock(baseDb, range.month, (db) =>
    reopenClosedMonth(db, { range, actorId, reason, input_hash: inputHash })
  );
  return res.status(result.status).json(result.body);
}
