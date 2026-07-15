/**
 * qb-operation-recovery.ts
 *
 * Runs every 5 minutes. Finds QB operations that are stuck in "processing"
 * (i.e., the server restarted mid-poll) and resumes them by querying the bridge
 * for the latest status and updating the entity metadata accordingly.
 *
 * A stuck operation is: status='processing', qb_operation_id IS NOT NULL,
 * initiated > 3 minutes ago (not brand new), initiated < 24 hours ago (not stale).
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { Client } from "pg";

import { bridgeFetch } from "../lib/quickbooks/client/core";
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
const LOG_PREFIX = "[QB-RECOVERY]";

interface StuckLog {
  id: string;
  operation: string;
  order_id: string | null;
  draft_order_id: string | null;
  qb_operation_id: string;
  metadata: Record<string, any> | null;
}

// ─── EditSequence extraction (mirrors pollOperationResult logic) ──────────────

function extractEditSequence(op: any): string | undefined {
  const r = op.result || {};
  const msgs = r.QBXML?.QBXMLMsgsRs || r.QBXMLMsgsRs || {};
  return (
    op.editSequence ||
    r.EditSequence ||
    msgs.EstimateAddRs?.EstimateRet?.EditSequence ||
    msgs.SalesOrderAddRs?.SalesOrderRet?.EditSequence ||
    msgs.InvoiceAddRs?.InvoiceRet?.EditSequence ||
    msgs.SalesReceiptAddRs?.SalesReceiptRet?.EditSequence ||
    msgs.ReceivePaymentAddRs?.ReceivePaymentRet?.EditSequence ||
    msgs.CreditMemoAddRs?.CreditMemoRet?.EditSequence ||
    msgs.CheckAddRs?.CheckRet?.EditSequence ||
    msgs.EstimateModRs?.EstimateRet?.EditSequence ||
    msgs.SalesOrderModRs?.SalesOrderRet?.EditSequence ||
    msgs.InvoiceModRs?.InvoiceRet?.EditSequence ||
    msgs.SalesReceiptModRs?.SalesReceiptRet?.EditSequence ||
    msgs.ReceivePaymentModRs?.ReceivePaymentRet?.EditSequence ||
    msgs.CreditMemoModRs?.CreditMemoRet?.EditSequence ||
    msgs.CheckModRs?.CheckRet?.EditSequence ||
    r.EstimateRet?.EditSequence ||
    r.SalesOrderRet?.EditSequence ||
    r.InvoiceRet?.EditSequence ||
    r.SalesReceiptRet?.EditSequence ||
    r.ReceivePaymentRet?.EditSequence ||
    r.CreditMemoRet?.EditSequence ||
    r.CheckRet?.EditSequence ||
    undefined
  );
}

// ─── Edit sequence cache upsert ───────────────────────────────────────────────

async function upsertEditSequenceCache(
  client: Client,
  entityType: string,
  qbId: string,
  editSequence: string
): Promise<void> {
  await client.query(
    `
        INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_sequence, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (entity_type, qb_id)
        DO UPDATE SET edit_sequence = EXCLUDED.edit_sequence, updated_at = NOW()
    `,
    [entityType, qbId, editSequence]
  );
}

// ─── Entity metadata update per operation type ────────────────────────────────

async function applyRecoveryResult(
  client: Client,
  log: StuckLog,
  txnId: string | undefined,
  refNumber: string | undefined,
  editSequence: string | undefined,
  logger: any
): Promise<void> {
  if (!txnId) return;

  switch (log.operation) {
    case "sales_order": {
      if (!log.order_id) break;
      const patch: Record<string, any> = {
        qb_so_txn_id: txnId,
        qb_sync_status: "synced",
      };
      if (refNumber) patch.qb_so_ref_number = refNumber;
      await client.query(
        `UPDATE "order" SET metadata = COALESCE(metadata,'{}') || $2::jsonb WHERE id = $1`,
        [log.order_id, JSON.stringify(patch)]
      );
      if (editSequence)
        await upsertEditSequenceCache(
          client,
          "sales_order",
          txnId,
          editSequence
        );
      logger.info(
        `${LOG_PREFIX} ✅ Recovered sales_order for order ${log.order_id} → TxnID: ${txnId}`
      );
      break;
    }

    case "estimate": {
      if (!log.draft_order_id) break;
      const patch: Record<string, any> = {
        qb_estimate_txn_id: txnId,
        qb_sync_status: "synced",
      };
      if (refNumber) patch.qb_estimate_ref_number = refNumber;
      if (editSequence) patch.qb_edit_sequence = editSequence;
      await client.query(
        `UPDATE draft_order SET metadata = COALESCE(metadata,'{}') || $2::jsonb WHERE id = $1`,
        [log.draft_order_id, JSON.stringify(patch)]
      );
      if (editSequence)
        await upsertEditSequenceCache(client, "estimate", txnId, editSequence);
      logger.info(
        `${LOG_PREFIX} ✅ Recovered estimate for draft ${log.draft_order_id} → TxnID: ${txnId}`
      );
      break;
    }

    case "payment": {
      if (!log.order_id) break;
      const patch: Record<string, any> = {
        qb_txn_id: txnId,
        qb_sync_status: "synced",
      };
      if (refNumber) patch.qb_ref_number = refNumber;
      // Update the most recent 'creating' payment for this order
      await client.query(
        `
                UPDATE customer_payment
                SET metadata = COALESCE(metadata,'{}') || $2::jsonb
                WHERE id = (
                    SELECT id FROM customer_payment
                    WHERE metadata->>'order_id' = $1
                      AND metadata->>'qb_sync_status' = 'creating'
                    ORDER BY created_at DESC
                    LIMIT 1
                )
            `,
        [log.order_id, JSON.stringify(patch)]
      );
      logger.info(
        `${LOG_PREFIX} ✅ Recovered payment for order ${log.order_id} → TxnID: ${txnId}`
      );
      break;
    }

    case "invoice": {
      if (!log.order_id) break;
      const patch: Record<string, any> = {
        qb_invoice_txn_id: txnId,
        qb_sync_status: "synced",
      };
      if (refNumber) patch.qb_ref_number = refNumber;
      await client.query(
        `
                UPDATE pos_invoice
                SET metadata = COALESCE(metadata,'{}') || $2::jsonb
                WHERE id = (
                    SELECT id FROM pos_invoice
                    WHERE order_id = $1
                      AND (metadata->>'qb_sync_status' = 'creating'
                           OR metadata->>'qb_invoice_txn_id' IS NULL)
                    ORDER BY created_at DESC
                    LIMIT 1
                )
            `,
        [log.order_id, JSON.stringify(patch)]
      );
      if (editSequence)
        await upsertEditSequenceCache(client, "invoice", txnId, editSequence);
      logger.info(
        `${LOG_PREFIX} ✅ Recovered invoice for order ${log.order_id} → TxnID: ${txnId}`
      );
      break;
    }

    case "sales_receipt": {
      if (!log.order_id) break;
      const patch: Record<string, any> = {
        qb_sales_receipt_txn_id: txnId,
        qb_sync_status: "synced",
      };
      if (refNumber) patch.qb_sales_receipt_ref_number = refNumber;
      await client.query(
        `UPDATE "order" SET metadata = COALESCE(metadata,'{}') || $2::jsonb WHERE id = $1`,
        [log.order_id, JSON.stringify(patch)]
      );
      logger.info(
        `${LOG_PREFIX} ✅ Recovered sales_receipt for order ${log.order_id} → TxnID: ${txnId}`
      );
      break;
    }

    default:
      logger.info(
        `${LOG_PREFIX} ℹ️  No entity update handler for operation '${log.operation}' (TxnID: ${txnId})`
      );
  }
}

// ─── Main job ─────────────────────────────────────────────────────────────────

export default async function qbOperationRecovery(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  if (!(await isQbIntegrationEnabled())) return;

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Find stuck operations: processing + operationId persisted + 3min–24h old
    const { rows: stuckLogs } = await client.query<StuckLog>(`
            SELECT id, operation, order_id, draft_order_id, qb_operation_id, metadata
            FROM qb_sync_log
            WHERE status = 'processing'
              AND qb_operation_id IS NOT NULL
              AND initiated_at < NOW() - INTERVAL '3 minutes'
              AND initiated_at > NOW() - INTERVAL '24 hours'
            ORDER BY initiated_at ASC
            LIMIT 20
        `);

    if (stuckLogs.length === 0) return;

    logger.info(
      `${LOG_PREFIX} Found ${stuckLogs.length} stuck operation(s) — resuming...`
    );

    for (const log of stuckLogs) {
      try {
        const statusRes = await bridgeFetch(
          "GET",
          `/api/sync/status/${log.qb_operation_id}`
        );
        const op = statusRes?.operation;

        if (!op) continue;

        if (op.status === "completed") {
          const txnId: string | undefined =
            op.txnId || op.result?.TxnID || op.listId || op.result?.ListID;
          const refNumber: string | undefined =
            op.refNumber || op.result?.RefNumber;
          const editSequence = extractEditSequence(op);

          // Mark log completed
          await client.query(
            `
                        UPDATE qb_sync_log SET
                            status = 'completed',
                            completed_at = NOW(),
                            duration_ms = EXTRACT(EPOCH FROM (NOW() - initiated_at)) * 1000,
                            qb_txn_id = COALESCE($2, qb_txn_id),
                            qb_ref_number = COALESCE($3, qb_ref_number),
                            message = COALESCE(message, '') || ' [recovered by startup job]'
                        WHERE id = $1
                    `,
            [log.id, txnId ?? null, refNumber ?? null]
          );

          // Update entity
          await applyRecoveryResult(
            client,
            log,
            txnId,
            refNumber,
            editSequence,
            logger
          );
        } else if (op.status === "failed") {
          await client.query(
            `
                        UPDATE qb_sync_log SET
                            status = 'failed',
                            completed_at = NOW(),
                            error = $2
                        WHERE id = $1
                    `,
            [log.id, op.error || "Bridge operation failed"]
          );

          // Mark entity as error
          if (log.order_id) {
            await client.query(
              `UPDATE "order" SET metadata = COALESCE(metadata,'{}') || '{"qb_sync_status":"error"}'::jsonb WHERE id = $1`,
              [log.order_id]
            );
          }
          logger.warn(
            `${LOG_PREFIX} ⚠️  Operation ${log.qb_operation_id} failed in bridge (${log.operation})`
          );
        } else {
          // still pending/processing in bridge — leave it, check next run
          logger.info(
            `${LOG_PREFIX} ⏳ Operation ${log.qb_operation_id} still ${op.status} — will retry`
          );
        }
      } catch (err: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️  Could not recover ${log.qb_operation_id}: ${err.message}`
        );
      }
    }
  } catch (err: any) {
    logger.error(`${LOG_PREFIX} ❌ Job error: ${err.message}`);
  } finally {
    await client.end();
  }
}

export const config = {
  name: "qb-operation-recovery",
  schedule: "*/5 * * * *", // Every 5 minutes
};
