import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";

import { clearBillMissingInQb } from "../../../../../lib/quickbooks/pipeline/vendor-bill-missing";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../../../purchase-orders/_lib/auth";

type KnexLike = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
};

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { id } = req.params as { id: string };
  const knex = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as KnexLike;
  const billResult = await knex.raw(
    `SELECT id, purchase_order_id, qb_txn_id, qb_ref_number, qb_missing_in_qb_at
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = billResult.rows[0] as
    | {
        id: string;
        purchase_order_id: string | null;
        qb_txn_id: string | null;
        qb_ref_number: string | null;
        qb_missing_in_qb_at: Date | string | null;
      }
    | undefined;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (!bill.qb_txn_id) {
    return res.status(409).json({
      error: "Vendor bill is not linked to QuickBooks",
      code: "bill_not_synced",
    });
  }

  // A human asking for a re-check is the ONLY thing that clears the
  // "gone from QuickBooks" marker. Nothing clears it automatically — an automatic
  // clear would restore the one-dead-row-per-hour loop the marker exists to stop.
  // Cleared before the already-queued early return below, so the request always
  // un-sticks the bill even when a row is already in flight.
  const wasMissingInQb = bill.qb_missing_in_qb_at != null;
  if (wasMissingInQb) {
    await clearBillMissingInQb(id);
  }

  const existingResult = await knex.raw(
    `SELECT id
       FROM qb_order_pipeline
      WHERE reference_id = ?
        AND reference_type = 'vendor_bill'
        AND step = 'vendor_bill_payment_check'
        AND status IN ('pending', 'processing', 'submitted', 'waiting')
      ORDER BY created_at DESC
      LIMIT 1`,
    [id]
  );
  const existing = existingResult.rows[0] as { id: string } | undefined;
  if (existing) {
    return res.status(202).json({
      status: "payment_check_queued",
      pipeline_row_id: existing.id,
      already_queued: true,
      missing_in_qb_cleared: wasMissingInQb,
    });
  }

  const pipelineRowId = randomUUID();
  await knex.raw(
    `INSERT INTO qb_order_pipeline (
       id, order_id, reference_id, reference_type, step, status,
       qb_txn_id, payload, created_at, updated_at
     ) VALUES (?, ?, ?, 'vendor_bill', 'vendor_bill_payment_check', 'pending',
               ?, ?::jsonb, NOW(), NOW())`,
    [
      pipelineRowId,
      bill.purchase_order_id,
      id,
      bill.qb_txn_id,
      JSON.stringify({
        vendor_bill_id: id,
        txn_id: bill.qb_txn_id,
        ref_number: bill.qb_ref_number,
      }),
    ]
  );
  return res.status(202).json({
    status: "payment_check_queued",
    pipeline_row_id: pipelineRowId,
    already_queued: false,
    missing_in_qb_cleared: wasMissingInQb,
  });
}
