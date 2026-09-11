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
import { bankingErrorResponse } from "../../../../../lib/accounting/banking-error-http";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { postVendorCredit, reverseVendorCredit } from "../../../../../lib/ledger";
import { enqueueVendorCreditMod } from "../../../../../lib/purchase-orders/qb-vendor-credit-enqueue";
import {
  reviseVendorCredit,
  VendorCreditError,
  type VendorCreditLineInput,
} from "../../../../../lib/vendor-credits";
import { applyVendorCreditStockDeltas } from "../../../../../lib/vendor-credits/stock";

/**
 * POST { credit_date?, reason?, memo?, vendor_bill_id?, lines? } — revises a
 * POSTED credit (plan vc-edit-mod-20260911). After the local commit, in this
 * order and best-effort like post/void:
 *   1. stock: the per-PO-line DELTA through the Inventory module (`stock`);
 *   2. GL: reverse the active entry and repost from the new rows;
 *   3. QB: `vendor_credit_mod` behind the credit's own chain (`qb`) — or
 *      nothing, when the add has not confirmed (it rebuilds from live rows).
 *
 * Refused while the QuickBooks Add is in flight (`submitted`/`processing`):
 * the document QB is about to create would not carry this change and the
 * Mod has no TxnID to address yet — 409 `qb_add_in_flight`, try again in a
 * minute.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { id } = req.params as { id: string };
  const body = req.body as {
    credit_date?: string;
    reason?: string | null;
    memo?: string | null;
    vendor_bill_id?: string | null;
    lines?: VendorCreditLineInput[];
  };
  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return res.status(400).json({ error: "lines must be an array.", code: "invalid_body" });
  }

  const pool = getDbPool();
  const { rows: inFlight } = await pool.query(
    `SELECT 1 FROM qb_order_pipeline
      WHERE reference_id = $1 AND step = 'vendor_credit_add' AND status IN ('submitted', 'processing')
      LIMIT 1`,
    [id]
  );
  if (inFlight.length > 0) {
    return res.status(409).json({
      error: "This credit is being sent to QuickBooks right now. Try again in a minute.",
      code: "qb_add_in_flight",
    });
  }

  const client = await pool.connect();
  let revised;
  try {
    revised = await reviseVendorCredit(client, id, body, actorId);
  } catch (error) {
    if (error instanceof VendorCreditError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  } finally {
    client.release();
  }

  const stockResult = await applyVendorCreditStockDeltas(req.scope, id, revised);

  await runLedgerHook(
    async (c) => {
      await reverseVendorCredit(c, id, actorId, "vendor credit revised");
      await postVendorCredit(c, id, actorId);
    },
    { source_kind: "vendor_credit", source_id: id }
  );

  const knex = req.scope.resolve("__pg_connection__") as SqlClient;
  const qbResult = await enqueueVendorCreditMod(knex, id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return res.json({ vendor_credit: { id: revised.id, number: revised.number }, stock: stockResult, qb: qbResult });
}
