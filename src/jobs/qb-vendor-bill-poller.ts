/**
 * Legacy Vendor Bill queue adapter.
 *
 * The consolidator is the only QuickBooks bridge caller. This job never
 * submits or polls bridge operations; it only adopts pre-dependency-chain
 * qb_vendor_bill_pipeline rows into qb_order_pipeline so old deployments can
 * drain safely after the purchase-chain migration.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "../lib/purchase-orders/qb-purchase-dependency-chain";
import { PURCHASE_EXISTENCE_CHECK_KEY } from "../lib/quickbooks/consolidator/purchase-operations";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

export type KnexRaw = PurchaseDependencyKnex;

export type BillDispatchGate =
  | { blocked: false }
  | { blocked: true; reason: string };

/**
 * Documentation-only non-EIR fence. EcoPowerTech uses Enhanced Inventory
 * Receiving, so this is intentionally not wired into dispatch.
 */
export async function checkLegacyApFence(
  knex: KnexRaw,
  purchaseOrderId: string
): Promise<BillDispatchGate> {
  const result = await knex.raw(
    `SELECT id, number, qb_item_receipt_list_id
       FROM purchase_order_receipt
      WHERE purchase_order_id = ?
        AND qb_item_receipt_list_id IS NOT NULL
        AND deleted_at IS NULL
      LIMIT 5`,
    [purchaseOrderId]
  );
  const rows = result.rows as Array<{
    id: string;
    number: string | null;
    qb_item_receipt_list_id: string;
  }>;
  if (rows.length === 0) return { blocked: false };

  const labels = rows.map((row) => row.number ?? row.id).join(", ");
  return {
    blocked: true,
    reason:
      `Held: legacy A/P fence — PO has ${rows.length} synced ItemReceipt(s) ` +
      `still live in QuickBooks (${labels}).`,
  };
}

/**
 * Reports pre-chain ItemReceipt work that could still mutate the same PO.
 * New operations are serialized in qb_order_pipeline instead.
 */
export async function checkInFlightReceiptFence(
  knex: KnexRaw,
  purchaseOrderId: string
): Promise<BillDispatchGate> {
  const result = await knex.raw(
    `SELECT id, status
       FROM qb_item_receipt_pipeline
      WHERE purchase_order_id = ?
        AND deleted_at IS NULL
        AND status IN ('waiting', 'submitted', 'error')
      LIMIT 5`,
    [purchaseOrderId]
  );
  const rows = result.rows as Array<{ id: string; status: string }>;
  if (rows.length === 0) return { blocked: false };

  const statuses = [...new Set(rows.map((row) => row.status))].join("/");
  return {
    blocked: true,
    reason:
      `Held: in-flight legacy ItemReceipt fence — PO has ${rows.length} ` +
      `row(s) in ${statuses}.`,
  };
}

export interface LegacyBillRow {
  id: string;
  vendor_bill_id: string;
  purchase_order_id: string | null;
  status: string;
  qb_operation_id: string | null;
  retries: number;
  next_retry_at: string | null;
  last_error: string | null;
  rebuild_generation: number;
  payload: Record<string, unknown> | null;
}

const LEGACY_EXISTENCE_CHECK_KEY = "__existence_check";
const MAX_ROWS_PER_TICK = 30;

function normalizePayload(row: LegacyBillRow): Record<string, unknown> {
  const payload = { ...(row.payload ?? {}) };
  const wasCheckingExistence =
    payload[LEGACY_EXISTENCE_CHECK_KEY] === true;
  delete payload[LEGACY_EXISTENCE_CHECK_KEY];
  return {
    ...payload,
    delegated_to_consolidator: true,
    qb_vendor_bill_pipeline_id: row.id,
    rebuild_generation: row.rebuild_generation ?? 0,
    ...(wasCheckingExistence
      ? { [PURCHASE_EXISTENCE_CHECK_KEY]: true }
      : {}),
  };
}

export async function adoptLegacyVendorBillRow(
  db: PurchaseDependencyKnex,
  candidate: LegacyBillRow
): Promise<string | null> {
  if (!db.transaction) {
    throw new Error("Legacy Vendor Bill adoption requires a transaction");
  }
  return db.transaction(async (trx) => {
    const lockedResult = await trx.raw(
      `SELECT id, vendor_bill_id, purchase_order_id, status,
              qb_operation_id, retries, next_retry_at, last_error,
              rebuild_generation, payload
         FROM qb_vendor_bill_pipeline
        WHERE id = ? AND deleted_at IS NULL
        FOR UPDATE`,
      [candidate.id]
    );
    const row = (lockedResult.rows[0] ?? null) as LegacyBillRow | null;
    if (!row || !row.purchase_order_id) return null;

    const pointerResult = await trx.raw(
      `SELECT order_pipeline_id
         FROM qb_vendor_bill_pipeline
        WHERE id = ?`,
      [row.id]
    );
    if (
      (pointerResult.rows[0] as { order_pipeline_id?: string | null } | undefined)
        ?.order_pipeline_id
    ) {
      return null;
    }

    const payload = normalizePayload(row);
    const operation = await enqueuePurchaseQbOperation(trx, {
      purchaseOrderId: row.purchase_order_id,
      referenceId: row.vendor_bill_id,
      referenceType: "vendor_bill",
      step: "vendor_bill_add",
      payload,
      operationKey: purchaseOperationKey(
        "vendor_bill_add",
        row.vendor_bill_id,
        payload
      ),
    });

    if (
      (row.status === "submitted" || row.status === "processing") &&
      row.qb_operation_id
    ) {
      await trx.raw(
        `UPDATE qb_order_pipeline
            SET status = 'submitted', bridge_op_id = ?,
                retry_count = ?, error = ?, next_retry_at = NULL,
                submitted_at = COALESCE(submitted_at, NOW()),
                updated_at = NOW()
          WHERE id = ?::uuid
            AND status NOT IN ('confirmed', 'fixed')`,
        [
          row.qb_operation_id,
          row.retries ?? 0,
          row.last_error,
          operation.id,
        ]
      );
    } else if (
      row.status === "error" ||
      row.status === "failed_permanent" ||
      row.status === "processing"
    ) {
      await trx.raw(
        `UPDATE qb_order_pipeline
            SET status = 'failed', bridge_op_id = NULL,
                retry_count = GREATEST(?, 1), error = ?,
                next_retry_at = ?::timestamptz,
                failed_at = NOW(), updated_at = NOW()
          WHERE id = ?::uuid
            AND status NOT IN ('confirmed', 'fixed')`,
        [
          row.retries ?? 0,
          row.last_error ??
            "Adopted legacy Vendor Bill row requires retry",
          row.status === "failed_permanent" ? null : row.next_retry_at,
          operation.id,
        ]
      );
    }

    await trx.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET order_pipeline_id = ?::uuid,
              payload = ?::jsonb,
              updated_at = NOW()
        WHERE id = ?`,
      [operation.id, JSON.stringify(payload), row.id]
    );
    return operation.id;
  });
}

export default async function qbVendorBillPoller(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  const knex = container.resolve(
    "__pg_connection__"
  ) as PurchaseDependencyKnex;
  const billModeEnabled = process.env.QB_VENDOR_BILL_MODE === "bill";
  const result = await knex.raw(
    `SELECT id, vendor_bill_id, purchase_order_id, status,
            qb_operation_id, retries, next_retry_at, last_error,
            rebuild_generation, payload
       FROM qb_vendor_bill_pipeline
      WHERE order_pipeline_id IS NULL
        AND intent = 'add'
        AND deleted_at IS NULL
        AND status IN (
          'waiting', 'submitted', 'processing', 'error', 'failed_permanent'
        )
      ORDER BY updated_at ASC
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  );

  let adopted = 0;
  for (const raw of result.rows) {
    const row = raw as LegacyBillRow;
    const mustDrainInFlight =
      row.status === "submitted" || row.status === "processing";
    const terminalFailure = row.status === "failed_permanent";
    if (!billModeEnabled && !mustDrainInFlight && !terminalFailure) continue;

    try {
      const operationId = await adoptLegacyVendorBillRow(knex, row);
      if (!operationId) continue;
      adopted += 1;
      logger.warn(
        `[qb-vb-poller] Adopted legacy Bill row ${row.id} into universal operation ${operationId}`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[qb-vb-poller] Could not adopt legacy Bill row ${row.id}: ${message}`
      );
    }
  }
  if (adopted > 0) {
    logger.info(
      `[qb-vb-poller] Adopted ${adopted} legacy Vendor Bill row(s); no bridge calls were made`
    );
  }
}

export const config = {
  name: "qb-vendor-bill-poller",
  schedule: "*/1 * * * *",
};
