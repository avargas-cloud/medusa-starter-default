import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";
import { bridgeFetch } from "../lib/quickbooks/client/core";

function compareTxnLineIds(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  const hexA = parseInt((a ?? "").split("-")[0] ?? a, 16);
  const hexB = parseInt((b ?? "").split("-")[0] ?? b, 16);
  if (!isNaN(hexA) && !isNaN(hexB)) return hexA - hexB;
  return String(a).localeCompare(String(b));
}
import { voidCreditMemoInQb } from "../lib/quickbooks/client/credit-memos";
import { voidInvoiceInQb } from "../lib/quickbooks/client/invoices";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../lib/quickbooks/client/sales-orders";
import { handleDraftOrderCreated } from "../subscribers/qb-draft-order-subscriber";
import { handleDraftOrderUpdated } from "../lib/quickbooks/handlers/handle-draft-order-updated";
import { handleFulfillmentCreated } from "../lib/quickbooks/handlers/handle-fulfillment-created";
import { handleOrderPlaced } from "../lib/quickbooks/handlers/handle-order-placed";
import { handleOrderUpdated } from "../lib/quickbooks/handlers/handle-order-updated";
import { handlePosPaymentApplied } from "../lib/quickbooks/handlers/handle-pos-payment-applied";
import { handleSalesReceiptCreated } from "../lib/quickbooks/handlers/handle-sales-receipt-created";
import { buildEstimatePatch } from "../lib/quickbooks/qb-metadata-types";
import { ensureCustomerInQb } from "../lib/quickbooks/order-flow-core";
import { syncCustomerDataExtToQb } from "../lib/quickbooks/sync-customer-data-ext";
import {
  claimAndResetForResubmit,
  confirmPipelineRow,
  failPipelineRow,
  cacheEditSequence,
  invalidateEditSequenceCache,
} from "../lib/quickbooks/qb-pipeline";

/**
 * Processes a single step='customer' pipeline row by calling ensureCustomerInQb.
 * On success, the row is marked 'confirmed' with qb_txn_id = qb_list_id and the
 * customer.metadata.qb_list_id is populated by ensureCustomerInQb itself.
 * On failure, the row is marked 'failed' with the error surfaced in the UI.
 */
async function processCustomerPipelineRow(
  row: { id: string; customer_id: string },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();

  try {
    const customer = await customerModule.retrieveCustomer(row.customer_id, {
      relations: ["addresses"],
    });

    const customerForQb = {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      company_name: (customer as any).company_name ?? null,
      phone: customer.phone ?? null,
      metadata: customer.metadata ?? {},
      addresses: (customer.addresses ?? []).map((a: any) => ({
        address_1: a.address_1,
        address_2: a.address_2,
        city: a.city,
        province: a.province,
        postal_code: a.postal_code,
        is_default_billing:
          a.is_default_billing ?? a.metadata?.is_default_billing ?? false,
        is_default_shipping:
          a.is_default_shipping ?? a.metadata?.is_default_shipping ?? false,
        metadata: a.metadata ?? {},
      })),
    };

    // Mark row 'submitted' so UI shows progress while the bridge call is in flight.
    await pool.query(
      `UPDATE qb_order_pipeline
          SET status = 'submitted', submitted_at = NOW(), updated_at = NOW(), error = NULL
        WHERE id = $1`,
      [row.id]
    );

    const result = await ensureCustomerInQb(
      customerForQb as any,
      customerModule,
      (msg) => logger.info(msg)
    );

    if (result.success && result.qbCustomerId) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status       = 'confirmed',
                qb_txn_id    = $2,
                confirmed_at = NOW(),
                updated_at   = NOW(),
                error        = NULL
          WHERE id = $1`,
        [row.id, result.qbCustomerId]
      );
      logger.info(
        `${LOG_PREFIX} ✅ Customer pipeline row ${row.id} confirmed — qb_list_id=${result.qbCustomerId}`
      );
    } else {
      const errMsg = result.error ?? "ensureCustomerInQb returned no qbCustomerId";
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status     = 'failed',
                failed_at  = NOW(),
                updated_at = NOW(),
                error      = $2
          WHERE id = $1`,
        [row.id, errMsg]
      );
      logger.warn(
        `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} failed: ${errMsg}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status     = 'failed',
                failed_at  = NOW(),
                updated_at = NOW(),
                error      = $2
          WHERE id = $1`,
        [row.id, msg]
      )
      .catch(() => {});
    logger.warn(
      `${LOG_PREFIX} ❌ Customer pipeline row ${row.id} exception: ${msg}`
    );
  }
}

/**
 * Processes a single step='customer_data_ext' pipeline row.
 * Escribe a QB el valor actual de customer.metadata.acquisition_channel
 * como DataExt "Distribution Channel" en el customer identificado por qb_list_id.
 * Idempotente: intenta DataExtAdd primero; si ya existe, cae a DataExtMod.
 */
async function processCustomerDataExtPipelineRow(
  row: { id: string; customer_id: string },
  customerModule: any,
  logger: any
): Promise<void> {
  const pool = getDbPool();

  try {
    const customer = await customerModule.retrieveCustomer(row.customer_id);
    const meta = (customer.metadata ?? {}) as Record<string, unknown>;
    const qbListId = typeof meta.qb_list_id === "string" ? meta.qb_list_id : null;
    const channel =
      typeof meta.acquisition_channel === "string"
        ? (meta.acquisition_channel as string).trim()
        : "";

    if (!qbListId) {
      // Customer todavía no sincronizado a QB. Esta fila debería haber estado
      // 'waiting' con depends_on del step='customer'. Si llegó acá sin qb_list_id,
      // la fallamos para investigar — no tiene sentido reintentar sin ese id.
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(),
                error='customer has no qb_list_id in metadata'
          WHERE id=$1`,
        [row.id]
      );
      return;
    }
    if (!channel) {
      // Sin valor en Medusa no hay nada que escribir a QB. Confirmamos la fila
      // como no-op para que no se reintente infinitamente.
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='confirmed', confirmed_at=NOW(), updated_at=NOW(),
                error=NULL
          WHERE id=$1`,
        [row.id]
      );
      return;
    }

    await pool.query(
      `UPDATE qb_order_pipeline
          SET status='submitted', submitted_at=NOW(), updated_at=NOW(), error=NULL
        WHERE id=$1`,
      [row.id]
    );

    const result = await syncCustomerDataExtToQb({
      qbListId,
      dataExtName: "Distribution Channel",
      dataExtValue: channel,
      logger: {
        info: (m) => logger.info(`${LOG_PREFIX} ${m}`),
        warn: (m) => logger.warn(`${LOG_PREFIX} ${m}`),
      },
    });

    if (result.success) {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='confirmed', confirmed_at=NOW(), updated_at=NOW(),
                error=NULL
          WHERE id=$1`,
        [row.id]
      );
      logger.info(
        `${LOG_PREFIX} ✅ customer_data_ext row ${row.id} confirmed (${result.action}): ${qbListId} = "${channel}"`
      );
    } else {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(), error=$2
          WHERE id=$1`,
        [row.id, result.error ?? "unknown data-ext error"]
      );
      logger.warn(
        `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} failed: ${result.error}`
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await pool
      .query(
        `UPDATE qb_order_pipeline
            SET status='failed', failed_at=NOW(), updated_at=NOW(), error=$2
          WHERE id=$1`,
        [row.id, msg]
      )
      .catch(() => {});
    logger.warn(
      `${LOG_PREFIX} ❌ customer_data_ext row ${row.id} exception: ${msg}`
    );
  }
}

/**
 * Re-submits a pipeline row that was coalesced while in-flight.
 * Called by the consolidator after a row is confirmed and next_payload was present.
 * The row has already been reset to 'pending' by claimAndResetForResubmit.
 */
async function resubmitByStep(
  row: {
    id: string;
    order_id: string | null;
    reference_id: string | null;
    reference_type: string | null;
    step: string;
    qb_txn_id?: string | null;
  },
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const orderModule = container.resolve(Modules.ORDER);
  const customerModule = container.resolve(Modules.CUSTOMER);

  try {
    switch (row.step) {
      case "estimate":
        if (!row.order_id) break;
        // Always attempt MOD first — handleDraftOrderUpdated reads the FRESH
        // qb_estimate_txn_id from order metadata (which was just updated by the
        // confirm step above). Returns "skipped" if metadata has no txn_id yet,
        // in which case we fall back to CREATE. Prevents duplicate QB Estimates
        // for coalesced saves picked up by the consolidator.
        {
          const outcome = await handleDraftOrderUpdated(
            row.order_id,
            container,
            logger,
            { isCron: true, awaitSerialized: true }
          );
          if (outcome === "skipped") {
            await handleDraftOrderCreated(
              { id: row.order_id },
              container,
              logger,
              true // isCron — skips the 1h POS delay guard
            );
          }
        }
        break;

      case "sales_order":
        if (!row.order_id) break;
        // Always try MOD first — handleOrderUpdated reads fresh qb_sales_order.txn_id
        // from metadata. Returns "skipped" when no txn_id exists (SO never made it
        // to QB) → fall back to CREATE via handleOrderPlaced. Prevents duplicate
        // QB Sales Orders on coalesced resubmits.
        {
          const outcome = await handleOrderUpdated(
            row.order_id,
            container,
            logger,
            { isCron: true, awaitSerialized: true }
          );
          if (outcome === "skipped") {
            await handleOrderPlaced(
              { id: row.order_id },
              orderModule,
              customerModule,
              container,
              logger,
              true
            );
          }
        }
        break;

      case "sales_receipt":
        if (!row.order_id) break;
        await handleSalesReceiptCreated(
          { id: row.order_id },
          orderModule,
          customerModule,
          container,
          logger
        );
        break;

      case "invoice":
        if (!row.order_id) break;
        await handleFulfillmentCreated(
          { order_id: row.order_id },
          orderModule,
          customerModule,
          container,
          logger
        );
        break;

      case "customer":
        if (!row.reference_id) break;
        await processCustomerPipelineRow(
          { id: row.id, customer_id: row.reference_id },
          customerModule,
          logger
        );
        break;

      case "customer_data_ext":
        if (!row.reference_id) break;
        await processCustomerDataExtPipelineRow(
          { id: row.id, customer_id: row.reference_id },
          customerModule,
          logger
        );
        break;

      case "apply_payment": {
        if (!row.reference_id) break;
        const applyPool = getDbPool();
        const { rows: appRows } = await applyPool.query(
          `SELECT payment_id, invoice_id, order_id, amount_applied
           FROM payment_application
           WHERE payment_id = $1 AND voided_at IS NULL
           LIMIT 1`,
          [row.reference_id]
        );
        const appRow = appRows[0];
        if (!appRow) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ No payment_application found for apply_payment row ${row.id} (ref=${row.reference_id})`
          );
          break;
        }
        await handlePosPaymentApplied({
          event: {
            name: "pos.payment.applied",
            data: {
              payment_id: row.reference_id,
              invoice_id: appRow.invoice_id ?? null,
              order_id: appRow.order_id ?? row.order_id,
              amount_applied: appRow.amount_applied ?? 0,
            },
          },
          container,
        } as any);
        break;
      }

      default:
        // payment and other steps: reset to pending and let qb-pos-sync pick up
        logger.info(
          `${LOG_PREFIX} ℹ️ Coalesced resubmit for step=${row.step} — row reset to pending, will be picked up by next cron`
        );
    }
  } catch (err: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ resubmitByStep failed for row ${row.id} (${row.step}): ${err.message}`
    );
  }
}

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Runs every 2 minutes.
 * - Polls bridge for submitted pipeline rows that have a bridge_op_id
 * - Marks them confirmed or failed based on bridge response
 * - Saves EditSequence from confirmed responses to the cache
 */
export default async function qbPipelineConsolidator(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return;

  const pool = getDbPool();

  // Fetch all submitted rows that have a bridge_op_id (up to 50 at a time)
  let submittedRows: Array<{
    id: string;
    order_id: string | null;
    reference_id: string | null;
    reference_type: string | null;
    step: string;
    bridge_op_id: string;
    retry_count: number;
    qb_txn_id: string | null;
  }>;

  try {
    const { rows } = await pool.query(`
            SELECT id, order_id, reference_id, reference_type, step, bridge_op_id, retry_count, qb_txn_id
            FROM qb_order_pipeline
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
            ORDER BY COALESCE(updated_at, created_at) ASC
            LIMIT 50
        `);
    submittedRows = rows;
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} Failed to query submitted rows: ${err.message}`
    );
    return;
  }

  // NOTE: No early return aquí — los passes de customer / customer_data_ext
  // / wake-dependents / stale timeouts de abajo deben correr siempre, aunque
  // no haya submitted rows para pollear.
  if (submittedRows.length > 0) {
    logger.info(
      `${LOG_PREFIX} Polling ${submittedRows.length} submitted operations...`
    );
  }

  for (const row of submittedRows) {
    try {
      const statusRes = await bridgeFetch(
        "GET",
        `/api/sync/status/${row.bridge_op_id}`
      );
      const op = statusRes?.operation;

      if (!op) {
        logger.warn(
          `${LOG_PREFIX} No operation data for ${row.bridge_op_id} (row ${row.id})`
        );
        continue;
      }

      if (op.status === "completed") {
        const msgs = op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs;
        const txnId =
          op.txnId ||
          op.result?.TxnID ||
          op.listId ||
          op.result?.ListID ||
          msgs?.CheckAddRs?.CheckRet?.TxnID ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.TxnID ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.TxnID ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.TxnID ||
          null;
        const refNumber =
          op.refNumber ||
          op.result?.RefNumber ||
          msgs?.CheckAddRs?.CheckRet?.RefNumber ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.RefNumber ||
          null;

        await confirmPipelineRow(row.id, txnId, refNumber, op.result ?? null);

        // EditSequence: prefer the top-level field (set by bridge since fix),
        // fall back to digging into the raw result for older ops
        const editSeq: string | null =
          op.editSequence ||
          op.result?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.EstimateAddRs?.EstimateRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.EstimateModRs?.EstimateRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderAddRs?.SalesOrderRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderModRs?.SalesOrderRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.InvoiceAddRs?.InvoiceRet
            ?.EditSequence ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.EditSequence ||
          null;

        // Extract TxnLineID map (productId → [TxnLineID, ...]) from confirmed QB response.
        // Arrays support duplicate products on the same document.
        // Sorted by TxnLineID ascending so the queue matches QB line order.
        const extractLineIds = (
          lineRet: unknown
        ): Record<string, string[]> | null => {
          if (!lineRet) return null;
          const arr: unknown[] = Array.isArray(lineRet) ? lineRet : [lineRet];
          const sorted = [...arr].sort((a, b) =>
            compareTxnLineIds(
              String((a as Record<string, unknown>)?.TxnLineID ?? ""),
              String((b as Record<string, unknown>)?.TxnLineID ?? "")
            )
          );
          const map: Record<string, string[]> = {};
          for (const line of sorted) {
            const l = line as Record<string, unknown>;
            const pid = (l?.ItemRef as Record<string, unknown>)?.ListID as
              | string
              | undefined;
            const tid = l?.TxnLineID as string | undefined;
            if (pid && tid) {
              if (!map[pid]) map[pid] = [];
              map[pid].push(tid);
            }
          }
          return Object.keys(map).length > 0 ? map : null;
        };

        const lineIds: Record<string, string[]> | null =
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.EstimateAddRs?.EstimateRet
              ?.EstimateLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.EstimateModRs?.EstimateRet
              ?.EstimateLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderAddRs?.SalesOrderRet
              ?.SalesOrderLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderModRs?.SalesOrderRet
              ?.SalesOrderLineRet
          ) ??
          null;

        // Cache EditSequence (+ TxnLineIDs when available) so next mod can skip the GET round-trip
        if (editSeq && txnId) {
          await cacheEditSequence(
            row.step,
            txnId,
            editSeq,
            lineIds ?? undefined
          );
        }

        // Write TxnID + EditSequence back to order metadata so POS reflects confirmed
        // sync status and future Mod ops have EditSequence ready without a GET
        // For payment steps: write qb_txn_id to customer_payment.metadata so that
        // handlePosPaymentApplied can find it without waiting 400s for a value that
        // was never set (the payment handler only writes txnId when the bridge returns
        // it synchronously; async confirmations come through this consolidator path).
        // Credit memo step: write TxnID + EditSequence to pos_credit_memo
        // so future void operations can reference the QB record.

        // sales_receipt / invoice confirmed via async poll → propagate qb_sync_status='synced'
        // to pos_invoice.metadata AND clear stale 'error' on order.metadata.
        // Handler wrote qb_txn_id/qb_ref_number on its sync return, but qb_sync_status
        // stays 'error' when the retry went through the admin endpoint (which pre-sets
        // qb_sync_status='error' before calling the handler). Without this, the POS
        // invoice list shows X even though the pipeline is Confirmed.
        if (
          txnId &&
          (row.step === "sales_receipt" || row.step === "invoice") &&
          row.reference_id
        ) {
          try {
            await pool.query(
              `UPDATE pos_invoice
                             SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                             WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({
                  qb_txn_id: txnId,
                  qb_ref_number: refNumber,
                  qb_sync_status: "synced",
                }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Synced pos_invoice ${row.reference_id} → qb_sync_status='synced', TxnID=${txnId}`
            );
          } catch (posInvErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update pos_invoice metadata: ${posInvErr.message}`
            );
          }

          if (row.order_id) {
            try {
              await pool.query(
                `UPDATE "order"
                                 SET metadata = metadata || '{"qb_sync_status":"child_synced"}'::jsonb
                                 WHERE id = $1 AND metadata->>'qb_sync_status' = 'error'`,
                [row.order_id]
              );
            } catch (ordErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not clear stale qb_sync_status='error' on order ${row.order_id}: ${ordErr.message}`
              );
            }
          }
        }

        if (txnId && row.step === "credit_memo" && row.reference_id) {
          try {
            await pool.query(
              `UPDATE pos_credit_memo
                             SET qb_txn_id = $2, qb_edit_sequence = $3
                             WHERE id = $1`,
              [row.reference_id, txnId, editSeq ?? null]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} + editSeq to pos_credit_memo ${row.reference_id}`
            );
          } catch (cmErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update pos_credit_memo: ${cmErr.message}`
            );
          }

          // Also propagate qb_txn_id to the customer_payment (store credit) derived
          // from this credit memo — so it can be used as a QB credit when applying
          // to a future invoice via POST /api/payments/{qb_txn_id}/apply
          try {
            const { rows: cmRows } = await pool.query(
              `SELECT credit_memo_number FROM pos_credit_memo WHERE id = $1`,
              [row.reference_id]
            );
            const cmNumber = cmRows[0]?.credit_memo_number; // e.g. "CM-20066"
            if (cmNumber) {
              const { rowCount } = await pool.query(
                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE reference = $1
                                   AND (metadata->>'qb_txn_id') IS NULL`,
                [
                  cmNumber,
                  JSON.stringify({
                    qb_txn_id: txnId,
                    qb_sync_status: "synced",
                  }),
                ]
              );
              if (rowCount && rowCount > 0) {
                logger.info(
                  `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment linked to ${cmNumber}`
                );
              }
            }
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not propagate qb_txn_id to customer_payment: ${cpErr.message}`
            );
          }
        }

        // credit_memo confirmed → activate any waiting void_credit_memo rows
        // (handles race where CM was voided before consolidator wrote qb_txn_id)
        if (txnId && row.step === "credit_memo" && row.reference_id) {
          try {
            const { rows: waitingVoidCms } = await pool.query(
              `SELECT id FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting' AND step = 'void_credit_memo'`,
              [row.id]
            );
            for (const vcRow of waitingVoidCms) {
              try {
                const vcResult = await voidCreditMemoInQb(
                  txnId,
                  editSeq ?? null,
                  (m) => logger.info(m)
                );
                if (vcResult.success && vcResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3, submitted_at = NOW()
                                         WHERE id = $1`,
                    [vcRow.id, vcResult.data.operationId, txnId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting void_credit_memo ${vcRow.id} → op ${vcResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, qb_txn_id = $3, failed_at = NOW()
                                         WHERE id = $1`,
                    [vcRow.id, vcResult.error ?? "QB CM void failed", txnId]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate void_credit_memo ${vcRow.id}: ${vcResult.error}`
                  );
                }
              } catch (vcErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating void_credit_memo ${vcRow.id}: ${vcErr.message}`
                );
              }
            }
          } catch (vcListErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting void_credit_memo rows: ${vcListErr.message}`
            );
          }
        }

        // write_check confirmed → update CustomerPayment.qb = { status:'yes' }
        // and activate any waiting refund_payment rows (credit memo scenario)
        if (row.step === "write_check" && row.reference_id) {
          try {
            await pool.query(
              `UPDATE customer_payment
                             SET qb = $2::jsonb
                             WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({ status: "yes", check_txn_id: txnId ?? null }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ write_check confirmed → CustomerPayment ${row.reference_id} qb.status=yes`
            );
          } catch (wcErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update CustomerPayment qb after write_check: ${wcErr.message}`
            );
          }

          // Activate waiting refund_payment rows (ALL refund types)
          // CM refunds: creditTxnId = credit memo QB TxnID
          // Direct payment refunds: creditTxnId = original ReceivePayment QB TxnID
          if (txnId) {
            try {
              const { rows: rpRows } = await pool.query(
                `SELECT rp.id, rp.reference_id, rp.payload
                                 FROM qb_order_pipeline rp
                                 WHERE rp.step = 'refund_payment'
                                   AND rp.status = 'waiting'
                                   AND rp.depends_on = $1`,
                [row.id]
              );
              for (const rpRow of rpRows) {
                try {
                  const rpPayload = rpRow.payload ?? {};
                  const { rows: cpRows } = await pool.query(
                    `SELECT cp.reference, cp.amount, cp.metadata,
                                                cust.metadata->>'qb_list_id' AS customer_list_id
                                         FROM customer_payment cp
                                         JOIN customer cust ON cust.id = cp.customer_id
                                         WHERE cp.id = $1`,
                    [rpRow.reference_id]
                  );
                  const cp = cpRows[0];
                  if (!cp?.customer_list_id) {
                    logger.warn(
                      `${LOG_PREFIX} ⚠️ No customer QB ListID for refund_payment ${rpRow.id}`
                    );
                    continue;
                  }

                  // Determine creditTxnId based on refund type
                  let creditTxnId: string | null = null;

                  if (rpPayload.type === "credit_memo") {
                    // CM refund: credit = QB Credit Memo TxnID
                    const { rows: cmRows } = await pool.query(
                      `SELECT qb_txn_id FROM pos_credit_memo WHERE credit_memo_number = $1`,
                      [cp.reference]
                    );
                    creditTxnId = cmRows[0]?.qb_txn_id ?? null;
                    if (!creditTxnId) {
                      logger.warn(
                        `${LOG_PREFIX} ⚠️ No QB TxnID for credit memo ${cp.reference} — refund_payment skipped`
                      );
                      continue;
                    }
                  } else {
                    // Direct payment refund: credit = original ReceivePayment QB TxnID
                    creditTxnId =
                      rpPayload.originalPaymentTxnId ??
                      cp.metadata?.qb_txn_id ??
                      null;
                    if (!creditTxnId) {
                      logger.warn(
                        `${LOG_PREFIX} ⚠️ No original ReceivePayment TxnID for refund_payment ${rpRow.id} — skipping`
                      );
                      continue;
                    }
                  }

                  const refundAmount = cp.metadata?.refund_amount
                    ? Number(cp.metadata.refund_amount)
                    : Number(cp.amount);
                  const amountDollars = Number(refundAmount / 100).toFixed(2);

                  const rpRes = await bridgeFetch("POST", "/api/sync/enqueue", {
                    type: "receive-payment",
                    action: "add",
                    data: {
                      customerId: cp.customer_list_id,
                      invoiceId: txnId, // write check TxnID = open AR debit to close
                      creditTxnId: creditTxnId, // original payment or credit memo = credit to apply
                      amount: Number(amountDollars),
                      totalAmount: 0,
                      paymentAmount: 0,
                    },
                  });
                  if (!rpRes?.operation_id) {
                    logger.warn(
                      `${LOG_PREFIX} ⚠️ Bridge did not return operation_id for refund_payment ${rpRow.id}`
                    );
                    continue;
                  }
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                                         WHERE id = $1`,
                    [rpRow.id, rpRes.operation_id]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ refund_payment ${rpRow.id} activated (${rpPayload.type ?? "direct"}) → bridge op ${rpRes.operation_id}`
                  );
                } catch (rpErr: any) {
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate refund_payment ${rpRow.id}: ${rpErr.message}`
                  );
                }
              }
            } catch (rpListErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Error querying refund_payment rows: ${rpListErr.message}`
              );
            }
          }
        }

        if (txnId && row.step === "payment" && row.reference_id) {
          try {
            const { rows: cpRows } = await pool.query(
              `SELECT metadata FROM customer_payment WHERE id = $1`,
              [row.reference_id]
            );
            const cpMeta = cpRows[0]?.metadata || {};
            if (!cpMeta.qb_txn_id) {
              await pool.query(
                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE id = $1`,
                [
                  row.reference_id,
                  JSON.stringify({
                    qb_txn_id: txnId,
                    qb_sync_status: "synced",
                  }),
                ]
              );
              logger.info(
                `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment ${row.reference_id}`
              );
            }
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update customer_payment metadata: ${cpErr.message}`
            );
          }
        }

        // transfer_customer confirmed → write new editSequence to order metadata
        if (row.step === "transfer_customer" && row.order_id) {
          try {
            if (editSeq) {
              const orderModule = container.resolve(Modules.ORDER);
              const { rows: metaRows } = await pool.query(
                `SELECT metadata FROM "order" WHERE id = $1`,
                [row.order_id]
              );
              const existingMeta = metaRows[0]?.metadata || {};

              // Determine which document type this row covers based on referenceType
              const refType = (row as any).reference_type as string | null;
              let patch = existingMeta;
              if (refType === "sales_order") {
                const existing = existingMeta.qb_sales_order || {};
                patch = {
                  ...existingMeta,
                  qb_sales_order: { ...existing, edit_sequence: editSeq },
                  // Legacy flat field kept in sync
                  qb_sales_order_edit_sequence: editSeq,
                };
              } else if (refType === "invoice") {
                // Update edit_sequence on the last entry of the qb_invoices array
                const invoices = Array.isArray(existingMeta.qb_invoices)
                  ? existingMeta.qb_invoices
                  : [];
                if (invoices.length > 0) {
                  const updated = [...invoices];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    edit_sequence: editSeq,
                  };
                  patch = {
                    ...existingMeta,
                    qb_invoices: updated,
                    qb_invoice_edit_sequence: editSeq,
                  };
                }
              }

              await orderModule.updateOrders(row.order_id, { metadata: patch });
              logger.info(
                `${LOG_PREFIX} ✅ transfer_customer confirmed — updated editSeq for ${refType} on order ${row.order_id}`
              );
            } else {
              logger.info(
                `${LOG_PREFIX} ℹ️ transfer_customer confirmed but no editSeq in response — metadata unchanged`
              );
            }
          } catch (tcErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update order metadata after transfer_customer: ${tcErr.message}`
            );
          }
        }

        // so_close / so_reopen confirmed → activate any waiting dependent rows
        if (row.step === "so_close" || row.step === "so_reopen") {
          try {
            const { rows: waitingRows } = await pool.query(
              `SELECT id, step, order_id FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('so_close', 'so_reopen')`,
              [row.id]
            );
            for (const waitingRow of waitingRows) {
              try {
                const { rows: orderRows } = await pool.query(
                  `SELECT metadata FROM "order" WHERE id = $1`,
                  [waitingRow.order_id]
                );
                const wMeta = orderRows[0]?.metadata || {};
                const wSoTxnId: string | undefined =
                  (wMeta.qb_sales_order as any)?.txn_id ||
                  wMeta.qb_so_txn_id ||
                  wMeta.qb_sales_order_txn_id;
                if (!wSoTxnId) {
                  logger.warn(
                    `${LOG_PREFIX} No soTxnId for waiting ${waitingRow.step} ${waitingRow.id} — skipping`
                  );
                  continue;
                }
                const wResult =
                  waitingRow.step === "so_close"
                    ? await closeSalesOrderInQb(wSoTxnId, (m) => logger.info(m))
                    : await reopenSalesOrderInQb(wSoTxnId, (m) =>
                        logger.info(m)
                      );
                if (wResult.success && wResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                                         WHERE id = $1`,
                    [waitingRow.id, wResult.data.operationId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting ${waitingRow.step} ${waitingRow.id} → op ${wResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, failed_at = NOW()
                                         WHERE id = $1`,
                    [waitingRow.id, wResult.error ?? "QB sync failed"]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate ${waitingRow.step} ${waitingRow.id}: ${wResult.error}`
                  );
                }
              } catch (wErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating waiting ${waitingRow.step} ${waitingRow.id}: ${wErr.message}`
                );
              }
            }
          } catch (soDepErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting so_close/so_reopen rows: ${soDepErr.message}`
            );
          }
        }

        // sales_order/estimate confirmed with txnId → activate waiting void rows
        // This handles the race where order.canceled fires before the SO is confirmed
        if (txnId && (row.step === "sales_order" || row.step === "estimate")) {
          try {
            const { rows: waitingVoids } = await pool.query(
              `SELECT id, step FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('void_sales_order', 'void_invoice')`,
              [row.id]
            );
            for (const voidRow of waitingVoids) {
              try {
                const vResult =
                  voidRow.step === "void_invoice"
                    ? await voidInvoiceInQb(txnId, (m) => logger.info(m))
                    : await closeSalesOrderInQb(txnId, (m) => logger.info(m));
                if (vResult.success && vResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3, submitted_at = NOW()
                                         WHERE id = $1`,
                    [voidRow.id, vResult.data.operationId, txnId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting ${voidRow.step} ${voidRow.id} → op ${vResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, qb_txn_id = $3, failed_at = NOW()
                                         WHERE id = $1`,
                    [voidRow.id, vResult.error ?? "QB void failed", txnId]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate ${voidRow.step} ${voidRow.id}: ${vResult.error}`
                  );
                }
              } catch (vErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating waiting ${voidRow.step} ${voidRow.id}: ${vErr.message}`
                );
              }
            }
          } catch (voidDepErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting void rows: ${voidDepErr.message}`
            );
          }
        }

        if (txnId && row.order_id && row.step !== "transfer_customer") {
          try {
            const orderModule = container.resolve(Modules.ORDER);
            const { rows: metaRows } = await pool.query(
              `SELECT metadata FROM "order" WHERE id = $1`,
              [row.order_id]
            );
            const existingMeta = metaRows[0]?.metadata || {};

            let patch: Record<string, any>;
            if (row.step === "estimate") {
              patch = buildEstimatePatch(existingMeta, {
                txnId,
                refNumber,
                operationId: null,
                editSequence: editSeq,
                syncStatus: "synced",
              });
            } else if (row.step === "sales_order" && txnId) {
              // Always persist SO TxnId — handles both fresh creation and updates.
              const existing =
                (existingMeta.qb_sales_order as Record<string, any> | undefined) || {};
              patch = {
                ...existingMeta,
                qb_sales_order: {
                  ...existing,
                  txn_id: txnId,
                  ref_number: refNumber || existing.ref_number || null,
                  operation_id: null,
                  edit_sequence: editSeq || existing.edit_sequence || null,
                  synced_at: new Date().toISOString(),
                },
                qb_sales_order_txn_id: txnId,
                qb_sync_status: "sales_order",
              };
            } else {
              // For other steps, only update if we have an editSequence to save
              // (full patches for Invoice/Payment are written by their own handlers)
              if (!editSeq) {
                logger.info(
                  `${LOG_PREFIX} ℹ️ No metadata update needed for step=${row.step} (no editSequence)`
                );
                continue;
              }
              // Merge editSequence into existing qb_<step> sub-object
              const stepKey =
                row.step === "invoice" ? "qb_invoices" : null;
              if (stepKey === null) {
                patch = existingMeta; // nothing to merge safely
              } else {
                patch = existingMeta; // qb_invoices patches handled by fulfillment handler
              }
            }

            await orderModule.updateOrders(row.order_id, { metadata: patch });
            logger.info(
              `${LOG_PREFIX} ✅ Updated order ${row.order_id} metadata — step=${row.step}, TxnID=${txnId}, editSequence=${editSeq ? "✓" : "—"}`
            );
          } catch (metaErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update order metadata for ${row.order_id}: ${metaErr.message}`
            );
          }
        }

        logger.info(
          `${LOG_PREFIX} ✅ Confirmed row ${row.id} (${row.step}) — TxnID=${txnId}, Ref=${refNumber}`
        );

        // next_payload coalescing: if a save arrived while this row was in-flight,
        // reset the same row to 'pending' and re-submit immediately.
        try {
          const hasCoalesced = await claimAndResetForResubmit(row.id);
          if (hasCoalesced) {
            logger.info(
              `${LOG_PREFIX} ⏩ Coalesced save detected for row ${row.id} (${row.step}) — resubmitting`
            );
            await resubmitByStep(row, container, logger);
          }
        } catch (resubErr: any) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Could not process coalesced save for row ${row.id}: ${resubErr.message}`
          );
        }
      } else if (op.status === "failed") {
        const errMsg = op.error || "QB operation failed (no details)";
        await failPipelineRow(row.id, errMsg);
        // Invalidate cached EditSequence — but only when the error implies
        // the cached value is wrong. Error 3175 ("transaction locked") means
        // QB never touched the document, so the cache is still valid.
        const isLockedError =
          errMsg.includes("3175") || errMsg.includes("could not be locked");
        if (row.qb_txn_id && !isLockedError) {
          await invalidateEditSequenceCache(
            row.step as string,
            row.qb_txn_id as string
          ).catch(() => {});
        }
        logger.warn(
          `${LOG_PREFIX} ❌ Failed row ${row.id} (${row.step}): ${errMsg}`
        );

        // so_close/so_reopen failed → cascade-fail any waiting dependent rows
        if (row.step === "so_close" || row.step === "so_reopen") {
          try {
            const { rowCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'failed',
                                 error        = $2,
                                 failed_at    = NOW(),
                                 confirmed_at = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('so_close', 'so_reopen')`,
              [row.id, `Dependency ${row.id} (${row.step}) failed`]
            );
            if (rowCount && rowCount > 0) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Cascade-failed ${rowCount} waiting row(s) dependent on ${row.id}`
              );
            }
          } catch (cascErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error cascade-failing dependents: ${cascErr.message}`
            );
          }
        }

        // credit_memo failed → skip waiting void_credit_memo rows (nothing was created)
        if (row.step === "credit_memo" && row.reference_id) {
          try {
            const { rowCount: vcSkipCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'skipped',
                                 error        = $2,
                                 submitted_at = NULL,
                                 confirmed_at = NULL,
                                 failed_at    = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting' AND step = 'void_credit_memo'`,
              [row.id, `Skipped — parent credit_memo never reached QB`]
            );
            if (vcSkipCount && vcSkipCount > 0) {
              logger.info(
                `${LOG_PREFIX} ℹ️ Skipped ${vcSkipCount} waiting void_credit_memo row(s) — parent failed`
              );
            }
          } catch (vcsfErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error skipping void_credit_memo rows: ${vcsfErr.message}`
            );
          }
        }

        // sales_order/estimate failed → skip any waiting void rows (nothing was created in QB)
        if (row.step === "sales_order" || row.step === "estimate") {
          try {
            const { rowCount: skipCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'skipped',
                                 error        = $2,
                                 submitted_at = NULL,
                                 confirmed_at = NULL,
                                 failed_at    = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('void_sales_order', 'void_invoice')`,
              [row.id, `Skipped — parent ${row.step} never reached QB`]
            );
            if (skipCount && skipCount > 0) {
              logger.info(
                `${LOG_PREFIX} ℹ️ Skipped ${skipCount} waiting void row(s) — parent ${row.step} failed`
              );
            }
          } catch (svErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error skipping void rows after parent failure: ${svErr.message}`
            );
          }
        }
      } else {
        // Still pending/processing on bridge side — nothing to do yet
        logger.info(
          `${LOG_PREFIX} ⏳ Row ${row.id} (${row.step}) bridge status: ${op.status}`
        );
      }
    } catch (pollErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Error polling row ${row.id} op ${row.bridge_op_id}: ${pollErr.message}`
      );
    }
  }

  // ── Recovery pass ──────────────────────────────────────────────────────────
  // Find waiting refund_payment rows whose depends_on write_check is already
  // confirmed but were never activated (e.g. server restarted mid-confirmation).
  try {
    const { rows: orphanRows } = await pool.query(`
            SELECT rp.id, rp.reference_id, rp.payload, wc.qb_txn_id AS check_txn_id
            FROM qb_order_pipeline rp
            JOIN qb_order_pipeline wc ON wc.id = rp.depends_on
            WHERE rp.step   = 'refund_payment'
              AND rp.status = 'waiting'
              AND wc.step   = 'write_check'
              AND wc.status = 'confirmed'
              AND wc.qb_txn_id IS NOT NULL
        `);

    if (orphanRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🔄 Recovery: found ${orphanRows.length} orphaned refund_payment row(s) to activate`
      );
    }

    for (const rpRow of orphanRows) {
      try {
        const checkTxnId: string = rpRow.check_txn_id;
        const rpPayload = rpRow.payload ?? {};

        const { rows: cpRows } = await pool.query(
          `SELECT cp.reference, cp.amount, cp.metadata,
                            cust.metadata->>'qb_list_id' AS customer_list_id
                     FROM customer_payment cp
                     JOIN customer cust ON cust.id = cp.customer_id
                     WHERE cp.id = $1`,
          [rpRow.reference_id]
        );
        const cp = cpRows[0];
        if (!cp?.customer_list_id) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: no customer QB ListID for refund_payment ${rpRow.id}`
          );
          continue;
        }

        let creditTxnId: string | null = null;
        if (rpPayload.type === "credit_memo") {
          const { rows: cmRows } = await pool.query(
            `SELECT qb_txn_id FROM pos_credit_memo WHERE credit_memo_number = $1`,
            [cp.reference]
          );
          creditTxnId = cmRows[0]?.qb_txn_id ?? null;
          if (!creditTxnId) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Recovery: no QB TxnID for credit memo ${cp.reference} — skipping ${rpRow.id}`
            );
            continue;
          }
        } else {
          creditTxnId =
            rpPayload.originalPaymentTxnId ?? cp.metadata?.qb_txn_id ?? null;
          if (!creditTxnId) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Recovery: no original payment TxnID for refund_payment ${rpRow.id} — skipping`
            );
            continue;
          }
        }

        const refundAmount = cp.metadata?.refund_amount
          ? Number(cp.metadata.refund_amount)
          : Number(cp.amount);
        const amountDollars = Number(refundAmount / 100).toFixed(2);

        const rpRes = await bridgeFetch("POST", "/api/sync/enqueue", {
          type: "receive-payment",
          action: "add",
          data: {
            customerId: cp.customer_list_id,
            invoiceId: checkTxnId,
            creditTxnId: creditTxnId,
            amount: Number(amountDollars),
            totalAmount: 0,
            paymentAmount: 0,
          },
        });
        if (!rpRes?.operation_id) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: bridge did not return operation_id for ${rpRow.id}`
          );
          continue;
        }
        await pool.query(
          `UPDATE qb_order_pipeline
                     SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                     WHERE id = $1`,
          [rpRow.id, rpRes.operation_id]
        );
        logger.info(
          `${LOG_PREFIX} ✅ Recovery: refund_payment ${rpRow.id} activated (${rpPayload.type ?? "direct"}) → bridge op ${rpRes.operation_id}`
        );
      } catch (recErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Recovery: failed to activate ${rpRow.id}: ${recErr.message}`
        );
      }
    }
  } catch (recoveryErr: any) {
    logger.warn(`${LOG_PREFIX} ⚠️ Recovery pass error: ${recoveryErr.message}`);
  }

  // ── Recovery pass: orphaned waiting so_close/so_reopen ─────────────────────
  // Handles cases where the server restarted mid-confirmation of the parent row.
  try {
    const { rows: orphanSoRows } = await pool.query(`
            SELECT child.id, child.step, child.order_id
            FROM qb_order_pipeline child
            JOIN qb_order_pipeline parent ON parent.id = child.depends_on
            WHERE child.step   IN ('so_close', 'so_reopen')
              AND child.status  = 'waiting'
              AND parent.step  IN ('so_close', 'so_reopen')
              AND parent.status = 'confirmed'
        `);

    if (orphanSoRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🔄 Recovery: found ${orphanSoRows.length} orphaned so_close/so_reopen row(s)`
      );
    }

    for (const soRow of orphanSoRows) {
      try {
        const { rows: orderRows } = await pool.query(
          `SELECT metadata FROM "order" WHERE id = $1`,
          [soRow.order_id]
        );
        const soMeta = orderRows[0]?.metadata || {};
        const soTxnId: string | undefined =
          (soMeta.qb_sales_order as any)?.txn_id ||
          soMeta.qb_so_txn_id ||
          soMeta.qb_sales_order_txn_id;
        if (!soTxnId) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: no soTxnId for ${soRow.step} ${soRow.id} — skipping`
          );
          continue;
        }
        const soResult =
          soRow.step === "so_close"
            ? await closeSalesOrderInQb(soTxnId, (m) => logger.info(m))
            : await reopenSalesOrderInQb(soTxnId, (m) => logger.info(m));
        if (soResult.success && soResult.data?.operationId) {
          await pool.query(
            `UPDATE qb_order_pipeline
                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                         WHERE id = $1`,
            [soRow.id, soResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ Recovery: ${soRow.step} ${soRow.id} activated → op ${soResult.data.operationId}`
          );
        } else {
          await pool.query(
            `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW() WHERE id = $1`,
            [soRow.id, soResult.error ?? "QB sync failed (recovery)"]
          );
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: failed to activate ${soRow.step} ${soRow.id}: ${soResult.error}`
          );
        }
      } catch (soRecErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Recovery: error activating ${soRow.step} ${soRow.id}: ${soRecErr.message}`
        );
      }
    }
  } catch (soRecoveryErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ SO recovery pass error: ${soRecoveryErr.message}`
    );
  }

  // ── Customer pipeline pass ─────────────────────────────────────────────────
  // Process step='customer' rows in 'pending' state by calling ensureCustomerInQb.
  // On success: row → confirmed with qb_txn_id=qb_list_id.
  // On failure: row → failed with error visible in UI.
  // Limited to 10 per tick to stay under bridge rate limits.
  try {
    const { rows: pendingCustomers } = await pool.query(`
      SELECT id, reference_id
        FROM qb_order_pipeline
       WHERE step = 'customer'
         AND status = 'pending'
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingCustomers.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingCustomers.length} pending customer row(s)...`
      );
      for (const custRow of pendingCustomers) {
        await processCustomerPipelineRow(
          { id: custRow.id, customer_id: custRow.reference_id },
          customerModule,
          logger
        );
      }
    }
  } catch (custPassErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Customer pipeline pass error: ${custPassErr.message}`
    );
  }

  // ── Customer data-ext (custom fields) pass ─────────────────────────────────
  // Processes step='customer_data_ext' rows: escribe customer.metadata.acquisition_channel
  // al custom field "Distribution Channel" del customer en QB.
  try {
    const { rows: pendingDataExt } = await pool.query(`
      SELECT id, reference_id
        FROM qb_order_pipeline
       WHERE step = 'customer_data_ext'
         AND status = 'pending'
         AND reference_id IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) ASC
       LIMIT 10
    `);

    if (pendingDataExt.length > 0) {
      const customerModule = container.resolve(Modules.CUSTOMER);
      logger.info(
        `${LOG_PREFIX} Processing ${pendingDataExt.length} pending customer_data_ext row(s)...`
      );
      for (const r of pendingDataExt) {
        await processCustomerDataExtPipelineRow(
          { id: r.id, customer_id: r.reference_id },
          customerModule,
          logger
        );
      }
    }
  } catch (dePassErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ customer_data_ext pass error: ${dePassErr.message}`
    );
  }

  // ── Wake dependents pass ───────────────────────────────────────────────────
  // Any 'waiting' row whose depends_on row is now 'confirmed' is moved to
  // 'pending' AND the correct handler is re-fired immediately (same dispatch
  // the consolidator uses for coalesced resubmits). Typical case: a document
  // was blocked on customer creation; once the customer confirms, the
  // dependent document auto-resubmits with no user intervention.
  try {
    const { rows: awakenedRows } = await pool.query(
      `UPDATE qb_order_pipeline w
          SET status       = 'pending',
              updated_at   = NOW(),
              error        = NULL,
              failed_at    = NULL,
              submitted_at = NULL,
              bridge_op_id = NULL
         FROM qb_order_pipeline d
        WHERE w.depends_on = d.id
          AND w.status     = 'waiting'
          AND d.status     = 'confirmed'
        RETURNING w.id, w.order_id, w.reference_id, w.reference_type, w.step, w.qb_txn_id`
    );
    if (awakenedRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} ⏯️ Woke ${awakenedRows.length} waiting row(s) whose dependencies confirmed`
      );
      for (const r of awakenedRows) {
        await resubmitByStep(
          {
            id: r.id,
            order_id: r.order_id,
            reference_id: r.reference_id,
            reference_type: r.reference_type,
            step: r.step,
            qb_txn_id: r.qb_txn_id,
          },
          container,
          logger
        );
      }
    }
  } catch (wakeErr: any) {
    logger.warn(`${LOG_PREFIX} ⚠️ Wake-dependents pass error: ${wakeErr.message}`);
  }

  // ── Timeout pass: pending rows stuck for >20 minutes → failed ──────────────
  // Covers cases where the async QB call threw before ever reaching 'submitted'
  // (e.g. bad query.graph fields, network error, bridge down).
  try {
    const { rows: timedOutRows, rowCount } = await pool.query(`
            UPDATE qb_order_pipeline
            SET    status     = 'failed',
                   updated_at = NOW(),
                   error      = 'Timed out in pending state (>20 min) — no response from QB bridge',
                   failed_at  = NOW()
            WHERE  status = 'pending'
              AND  COALESCE(updated_at, created_at) < NOW() - INTERVAL '20 minutes'
            RETURNING id, step, order_id
        `);
    if (rowCount && rowCount > 0) {
      for (const r of timedOutRows) {
        logger.warn(
          `${LOG_PREFIX} ⏱️ Timed-out pending row → failed: id=${r.id} step=${r.step} order=${r.order_id}`
        );
      }
    }
  } catch (timeoutErr: any) {
    logger.warn(`${LOG_PREFIX} ⚠️ Timeout pass error: ${timeoutErr.message}`);
  }

  // ── Stale row cleanup ──────────────────────────────────────────────────────
  // Mark rows that have been stuck in 'submitted' for >30 min as failed
  // and invalidate their EditSequence cache so stale sequences aren't reused.
  try {
    const { rows: staleSubmitted } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status = 'failed', error = 'Stale: no bridge confirmation after 30 minutes', updated_at = NOW(), failed_at = NOW(), confirmed_at = NULL
             WHERE status = 'submitted' AND updated_at < NOW() - INTERVAL '30 minutes'
             RETURNING id, step, qb_txn_id`
    );
    for (const row of staleSubmitted) {
      logger.warn(
        `${LOG_PREFIX} ⏱️ Marked stale submitted row ${row.id} (step=${row.step}) as failed`
      );
      if (row.qb_txn_id) {
        // step names align directly with entity type names used in the cache
        await invalidateEditSequenceCache(
          row.step as string,
          row.qb_txn_id as string
        ).catch(() => {});
      }
    }
  } catch (staleSubmittedErr: unknown) {
    const msg =
      staleSubmittedErr instanceof Error
        ? staleSubmittedErr.message
        : String(staleSubmittedErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Stale submitted cleanup error: ${msg}`);
  }

  // Mark rows that have been stuck in 'pending' for >20 min as failed
  // (complements the existing timeout pass — this version logs each row individually)
  try {
    const { rows: stalePending } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status = 'failed', error = 'Stale: never submitted within 20 minutes', updated_at = NOW(), failed_at = NOW(), confirmed_at = NULL
             WHERE status = 'pending' AND updated_at < NOW() - INTERVAL '20 minutes'
             RETURNING id, step`
    );
    for (const row of stalePending) {
      logger.warn(
        `${LOG_PREFIX} ⏱️ Marked stale pending row ${row.id} (step=${row.step}) as failed`
      );
    }
  } catch (stalePendingErr: unknown) {
    const msg =
      stalePendingErr instanceof Error
        ? stalePendingErr.message
        : String(stalePendingErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Stale pending cleanup error: ${msg}`);
  }
}

export const config = {
  name: "qb-pipeline-consolidator",
  schedule: "*/1 * * * *", // TODO: change back to */2 after testing
};
