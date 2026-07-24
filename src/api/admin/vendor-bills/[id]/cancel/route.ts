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
  // Optional, mirroring vendor-bills/[id]/route.ts: the resolved
  // __pg_connection__ is a real knex instance at runtime, but the container
  // types it loosely, so callers guard with `knex.transaction ? … : null`.
  transaction?: () => Promise<
    KnexInstance & { commit: () => Promise<void>; rollback: () => Promise<void> }
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

      // Restore the average, journal the reversal, retire the confirm's own
      // event, and close the cost-log row — as ONE unit.
      //
      // Transactional on purpose (2026-07-23). The confirm path appends to
      // variant_cost_event non-fatally, because there a lost journal entry
      // still leaves a correctly-costed bill. Here the write IS the cost
      // change: letting the metadata update land without its event would
      // recreate the exact failure this table exists to prevent — a cost that
      // moved with no record of what it used to be. If any statement fails,
      // the variant keeps its current average and the cost-log row stays open,
      // so the cancel can simply be retried.
      const trx = knex.transaction ? await knex.transaction() : null;
      const run = trx ?? knex;
      // Deterministic id minted by the confirm route for this (bill, variant).
      // Kept in sync with that route's own format — the reversal points at it
      // and retires it, rather than leaving two live events claiming different
      // costs for the same variant.
      const confirmEventId = `vce_cf_${bill.id.slice(-12)}_${log.product_variant_id.slice(-12)}`;
      try {
        await run.raw(
          `UPDATE product_variant
           SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('avg_landed_cost_cents', ?::float,
                                   'avg_landed_cost_updated_at', now()::text,
                                   'average_cost', (?::float) / 100.0,
                                   'average_cost_updated_at', now()::text,
                                   'average_cost_source', 'landed'),
               updated_at = NOW()
           WHERE id = ?`,
          [restoredAvg, restoredAvg, log.product_variant_id]
        );

        // currentAvg/restoredAvg are CENTS, so qty × their difference is
        // already a cents delta — no ×100. Negative when the cancel takes
        // value back out of the warehouse, which is the normal direction.
        await run.raw(
          `INSERT INTO variant_cost_event
             (id, product_variant_id, event_type, cost_field, effective_at, recorded_at,
              previous_unit_cost, new_unit_cost, quantity_on_hand_at_event,
              inventory_value_delta_cents, source_system, source_type, source_id,
              status, idempotency_key, vendor_bill_id, quantity_delta,
              reverses_event_id, reason_code)
           VALUES (?, ?, 'vendor_bill_cancel', 'average_cost', NOW(), NOW(),
                   ?::numeric, ?::numeric, ?::int, ?::bigint,
                   'medusa', 'vendor_bill_cancel', ?, 'active', ?, ?, ?::int, ?,
                   'vendor_bill_cancel')
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [
            `vce_vx_${bill.id.slice(-12)}_${log.product_variant_id.slice(-12)}`,
            log.product_variant_id,
            currentAvg / 100,
            restoredAvg / 100,
            qCurrent,
            Math.round(qCurrent * (restoredAvg - currentAvg)),
            bill.id,
            `cancel:${bill.id}:${log.product_variant_id}`,
            bill.id,
            -log.received_qty,
            confirmEventId,
          ]
        );

        // Retire the confirm's event. recost-window walks `status = 'active'`
        // to find a variant's next cost change; an undone confirm must stop
        // acting as that boundary — this cancel event takes its place.
        await run.raw(
          `UPDATE variant_cost_event
              SET status = 'reversed'
            WHERE id = ? AND status = 'active'`,
          [confirmEventId]
        );

        await run.raw(
          `UPDATE vendor_bill_cost_log SET reversed_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [log.id]
        );

        await trx?.commit();
      } catch (error) {
        await trx?.rollback().catch(() => {});
        throw error;
      }
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
