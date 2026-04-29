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

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { getPurchaseOrdersService } from "../../../purchase-orders/_lib/service-resolver";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
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

interface CostLogRow {
  id: string;
  product_variant_id: string;
  received_qty: number;
  landed_unit_cost_cents: number;
}

interface VariantMetadataRow {
  metadata: Record<string, unknown> | null;
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
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
    return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
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

  // 2. Load cost log entries for this bill
  const logResult = await knex.raw(
    `SELECT id, product_variant_id, received_qty, landed_unit_cost_cents
     FROM vendor_bill_cost_log
     WHERE vendor_bill_id = ? AND reversed_at IS NULL`,
    [bill.id]
  );
  const costLogs = logResult.rows as CostLogRow[];

  if (costLogs.length === 0) {
    return res.status(422).json({
      error: "No active cost log entries found for this bill",
      code: "no_cost_log",
    });
  }

  // 3. Reverse AVCO for each variant
  const warnings: string[] = [];

  await Promise.all(
    costLogs.map(async (log) => {
      // Current stocked_quantity across all locations
      const qResult = await knex.raw(
        `SELECT COALESCE(SUM(il.stocked_quantity)::int, 0) AS qty
         FROM inventory_level il
         JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
         WHERE pvii.variant_id = ? AND il.deleted_at IS NULL`,
        [log.product_variant_id]
      );
      const qCurrent: number =
        (qResult.rows[0] as { qty: number } | undefined)?.qty ?? 0;

      // Current avg
      const metaResult = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [log.product_variant_id]
      );
      const meta = (metaResult.rows[0] as VariantMetadataRow | undefined)
        ?.metadata;
      const currentAvg = Number(meta?.avg_landed_cost_cents ?? 0) || 0;

      // Reverse AVCO:
      //   restored_avg = (Q_current × current_avg − received_qty × locked_cost)
      //                  / (Q_current − received_qty)
      const qBeforeCancel = qCurrent - log.received_qty;
      let restoredAvg: number;

      if (qBeforeCancel > 0) {
        restoredAvg =
          (qCurrent * currentAvg - log.received_qty * log.landed_unit_cost_cents) /
          qBeforeCancel;
        // Clamp to 0 — rounding drift or concurrent updates can produce tiny negatives
        restoredAvg = Math.max(0, restoredAvg);
      } else {
        // All inventory from this receipt was sold — no cost basis to restore
        restoredAvg = 0;
        warnings.push(
          `variant ${log.product_variant_id}: inventory fully consumed, avg cost reset to 0`
        );
      }

      // Persist restored avg
      await knex.raw(
        `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('avg_landed_cost_cents', ?::float),
             updated_at = NOW()
         WHERE id = ?`,
        [restoredAvg, log.product_variant_id]
      );

      // Mark log entry as reversed
      await knex.raw(
        `UPDATE vendor_bill_cost_log SET reversed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [log.id]
      );
    })
  );

  // 4. Determine new status and queue QB void if synced
  const newStatus = bill.status === "synced" ? "voided" : "cancelled";

  if (bill.status === "synced") {
    await writePipelineRow({
      referenceId: bill.id,
      referenceType: "vendor_bill",
      step: "vendor_bill_void",
      status: "pending",
      medusaRefNumber: bill.number ?? bill.id,
      payload: {
        qb_txn_id: bill.qb_txn_id,
        qb_edit_sequence: bill.qb_edit_sequence,
      },
    });
  }

  // 5. Update bill status
  await service.updateVendorBills({ id: bill.id }, { status: newStatus });

  const updatedBills = (await service.listVendorBills(
    { id: bill.id },
    { take: 1 }
  )) as unknown as VendorBillRow[];

  return res.json({
    vendor_bill: updatedBills[0] ?? {},
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
