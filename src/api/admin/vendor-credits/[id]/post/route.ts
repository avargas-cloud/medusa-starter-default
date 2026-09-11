import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import type { SqlClient } from "../../../../../lib/accounting/month-close-data";
import { markVendorCreditPosted, VendorCreditError } from "../../../../../lib/vendor-credits";
import { moveVendorCreditStock } from "../../../../../lib/vendor-credits/stock";
import { bankingErrorResponse } from "../../../../../lib/accounting/banking-error-http";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { postVendorCredit } from "../../../../../lib/ledger";
import { enqueueVendorCreditAdd } from "../../../../../lib/purchase-orders/qb-vendor-credit-enqueue";

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

/**
 * draft → posted. AFTER the local commit, three best-effort effects in this
 * order — none can un-post the credit (same discipline as vendor bill
 * confirm), and each surfaces in the response so the operator sees it
 * without needing the reconciler/digest:
 *   1. stock: returned units leave the PO's location (Inventory module,
 *      idempotent by `stock_applied_at`) — `stock` field;
 *   2. GL: AP debit / inventory_asset credit — via the ledger hook;
 *   3. QB: `VendorCreditAdd` enqueued — `qb` field.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const { id } = req.params as { id: string };
  const pgClient = await getDbPool().connect();
  let posted: { id: string; number: string };
  try {
    posted = await markVendorCreditPosted(pgClient, id, actorId);
  } catch (error) {
    if (error instanceof VendorCreditError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  } finally {
    pgClient.release();
  }

  const stockResult = await moveVendorCreditStock(req.scope, getDbPool(), id, "apply");

  await runLedgerHook((client) => postVendorCredit(client, id, actorId), {
    source_kind: "vendor_credit",
    source_id: id,
  });

  const knex = req.scope.resolve("__pg_connection__") as SqlClient;
  const qbResult = await enqueueVendorCreditAdd(knex, id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return res.json({ vendor_credit: posted, stock: stockResult, qb: qbResult });
}
