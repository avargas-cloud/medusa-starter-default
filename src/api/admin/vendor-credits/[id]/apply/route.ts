import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { postVendorBillAdjustment } from "../../../../../lib/ledger/documents/vendor-bill-adjustment";
import { applyVendorCreditToBill, VendorCreditError } from "../../../../../lib/vendor-credits";
import type { SqlClient } from "../../../../../lib/accounting/month-close-data";
import { enqueueVendorCreditApply } from "../../../../../lib/purchase-orders/qb-vendor-credit-apply-enqueue";

/** POST { vendor_bill_id, amount_cents }: apply (part of) this credit to a bill. */
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
  const body = req.body as { vendor_bill_id?: string; amount_cents?: number };
  if (!body.vendor_bill_id || typeof body.amount_cents !== "number") {
    return res.status(400).json({
      error: "vendor_bill_id and amount_cents are required.",
      code: "invalid_body",
    });
  }

  const client = await getDbPool().connect();
  let application: { id: string; auto_adjustment_ids: string[] };
  try {
    application = await applyVendorCreditToBill(client, {
      creditId: id,
      vendorBillId: body.vendor_bill_id,
      amountCents: body.amount_cents,
      actorId,
    });
  } catch (error) {
    if (error instanceof VendorCreditError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    client.release();
  }

  // ap-rounding-cleanup-20260916: post the rounding adjustment the apply may
  // have created (same transaction as the application) to the GL.
  for (const adjustmentId of application.auto_adjustment_ids) {
    await runLedgerHook((c) => postVendorBillAdjustment(c, adjustmentId, actorId), {
      source_kind: "vendor_bill_adjustment",
      source_id: adjustmentId,
    });
  }

  const knex = req.scope.resolve("__pg_connection__") as SqlClient;
  const qb = await enqueueVendorCreditApply(knex, application.id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return res.status(201).json({ application, qb });
}
