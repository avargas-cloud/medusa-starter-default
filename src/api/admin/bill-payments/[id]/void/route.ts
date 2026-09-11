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
import { voidBillPayment, BillPaymentError } from "../../../../../lib/bill-payments";
import { bankingErrorResponse } from "../../../../../lib/accounting/banking-error-http";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { reverseBillPayment } from "../../../../../lib/ledger";
import { enqueueBillPaymentVoid } from "../../../../../lib/purchase-orders/qb-bill-payment-enqueue";

/** POST { reason? }: voids the payment (allocations release, never delete). */
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
  const body = req.body as { reason?: string | null };
  const client = await getDbPool().connect();
  try {
    await voidBillPayment(client, id, actorId, body.reason ?? null);
  } catch (error) {
    if (error instanceof BillPaymentError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  } finally {
    client.release();
  }

  await runLedgerHook((c) => reverseBillPayment(c, id, actorId, body.reason ?? undefined), {
    source_kind: "vendor_bill_payment",
    source_id: id,
  });

  const knex = req.scope.resolve("__pg_connection__") as SqlClient;
  const qbResult = await enqueueBillPaymentVoid(knex, id).catch((err: unknown) => ({
    queued: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  return res.json({ id, qb: qbResult });
}
