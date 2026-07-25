/**
 * POST /admin/vendor-bills/:id/cancel
 *
 * Cancels a confirmed or synced vendor bill:
 *
 *   confirmed → cancelled  (local cost reversal only)
 *   synced    → voided     (local cost reversal + QB void queued via pipeline)
 *
 * Cost reversal uses the same QB AVCO logic in reverse:
 *   restored_avg = (Q_current × current_avg − received_qty × locked_landed_cost)
 *                  / (Q_current − received_qty)
 *
 * The "locked_landed_cost" comes from vendor_bill_cost_log, which was written
 * at confirm time — so the reversal is exact regardless of time elapsed.
 *
 * This is a financial-only operation: inventory levels are NOT changed.
 */

import { randomUUID } from "crypto";

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  applyVendorBillRemovalReplay,
  previewVendorBillRemoval,
} from "../../../../../lib/cost/vendor-bill-replay";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../../../purchase-orders/_lib/auth";
import { getPurchaseOrdersService } from "../../../purchase-orders/_lib/service-resolver";

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  // Optional, mirroring vendor-bills/[id]/route.ts: the resolved
  // __pg_connection__ is a real knex instance at runtime, but the container
  // types it loosely, so callers guard with `knex.transaction ? … : null`.
  transaction: () => Promise<
    KnexInstance & {
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
    }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── Shapes ────────────────────────────────────────────────────────────────────

interface VendorBillRow {
  id: string;
  number: string | null;
  status: string;
  qb_txn_id: string | null;
  qb_edit_sequence: string | null;
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorUserId: string | null = null;
  try {
    actorUserId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err as Error;
  }
  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);
  const knex = resolveKnex(req);

  // 1. Load vendor bill
  const bills = (await service.listVendorBills(
    { id },
    { take: 1 }
  )) as unknown as VendorBillRow[];

  const bill = bills[0];
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (bill.status === "draft") {
    return res.status(400).json({
      error: "Draft bills should be deleted, not cancelled",
      code: "use_delete",
    });
  }
  if (bill.status === "cancelled" || bill.status === "voided") {
    return res.status(409).json({
      error: `Vendor bill is already ${bill.status}`,
      code: "already_cancelled",
    });
  }
  if (bill.status !== "confirmed" && bill.status !== "synced") {
    return res.status(409).json({
      error: `Cannot cancel a bill with status '${bill.status}'`,
      code: "invalid_status",
    });
  }

  // Synced bills require QB TxnID to void
  if (bill.status === "synced" && !bill.qb_txn_id) {
    return res.status(422).json({
      error: "Cannot void a synced bill without a QuickBooks TxnID",
      code: "missing_qb_txn_id",
    });
  }

  // Build the exact projection first. Apply re-runs it under locks and rejects
  // moved inputs, so removing middle event B correctly rebuilds C and every
  // affected sale instead of attempting an algebraic rollback.
  let preview;
  try {
    preview = await previewVendorBillRemoval(knex, bill.id, actorUserId);
  } catch (error) {
    return res.status(422).json({
      error:
        error instanceof Error ? error.message : "Unable to build cost replay",
      code: "cost_replay_failed",
    });
  }

  const trx = await knex.transaction();
  const newStatus = bill.status === "synced" ? "voided" : "cancelled";
  try {
    const locked = await trx.raw(
      `SELECT status, qb_txn_id, qb_edit_sequence
         FROM vendor_bill
        WHERE id = ? AND deleted_at IS NULL
        FOR UPDATE`,
      [bill.id]
    );
    const current = locked.rows[0] as
      | {
          status: string;
          qb_txn_id: string | null;
          qb_edit_sequence: string | null;
        }
      | undefined;
    if (!current || current.status !== bill.status) {
      throw new Error("Vendor bill changed while cancellation was prepared");
    }

    await applyVendorBillRemovalReplay(trx, preview);
    await trx.raw(
      `UPDATE vendor_bill_cost_log
          SET reversed_at = NOW(), updated_at = NOW()
        WHERE vendor_bill_id = ? AND reversed_at IS NULL`,
      [bill.id]
    );
    await trx.raw(
      `UPDATE variant_cost_event
          SET status = 'reversed'
        WHERE vendor_bill_id = ?
          AND event_type = 'vendor_bill_receipt'
          AND status = 'active'`,
      [bill.id]
    );
    await trx.raw(
      `UPDATE vendor_bill_revision
          SET status = 'superseded', superseded_at = NOW(), updated_at = NOW()
        WHERE vendor_bill_id = ? AND status = 'confirmed'`,
      [bill.id]
    );

    if (bill.status === "synced") {
      await trx.raw(
        `INSERT INTO qb_order_pipeline
           (id, reference_id, reference_type, step, status,
            medusa_ref_number, qb_txn_id, payload, created_at, updated_at)
         VALUES (?, ?, 'vendor_bill', 'vendor_bill_void', 'pending',
                 ?, ?, ?::jsonb, NOW(), NOW())`,
        [
          randomUUID(),
          bill.id,
          bill.number ?? bill.id,
          current.qb_txn_id,
          JSON.stringify({
            qb_txn_id: current.qb_txn_id,
            qb_edit_sequence: current.qb_edit_sequence,
          }),
        ]
      );
    }

    await trx.raw(
      `UPDATE vendor_bill
          SET status = ?, active_revision_id = NULL, updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [newStatus, bill.id]
    );
    await trx.commit();
  } catch (error) {
    await trx.rollback().catch(() => undefined);
    return res.status(422).json({
      error:
        error instanceof Error
          ? error.message
          : "Vendor bill cancellation failed",
      code: "vendor_bill_cancel_failed",
    });
  }

  const updatedBills = (await service.listVendorBills(
    { id: bill.id },
    { take: 1 }
  )) as unknown as VendorBillRow[];

  return res.json({
    vendor_bill: updatedBills[0] ?? {},
  });
}
