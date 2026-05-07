import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  cancelEstimateInQb,
} from "../client/estimates";
import { transferDocumentCustomer } from "../client/transfer";
import {
  updateCreditMemoInQb,
  createCreditMemoInQb,
  voidCreditMemoInQb,
} from "../client/credit-memos";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../client/sales-orders";
import { updateInvoiceInQb, voidInvoiceInQb } from "../client/invoices";
import {
  updateSalesReceiptInQb,
  voidSalesReceiptInQb,
} from "../client/sales-receipts";
import { voidCheckInQb } from "../client/checks";
import { handleDraftOrderUpdated } from "../handlers/handle-draft-order-updated";
import { handleFulfillmentCreated } from "../handlers/handle-fulfillment-created";
import { handleOrderPlaced } from "../handlers/handle-order-placed";
import { handleOrderUpdated } from "../handlers/handle-order-updated";
import { handlePosPaymentApplied } from "../handlers/handle-pos-payment-applied";
import { handleSalesReceiptCreated } from "../handlers/handle-sales-receipt-created";
import { failPipelineRow } from "../qb-pipeline";
import { handleDraftOrderCreated } from "../../../subscribers/qb-draft-order-subscriber";
import {
  processCustomerPipelineRow,
  processCustomerDataExtPipelineRow,
} from "./customer-pass";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

export type ResubmitRow = {
  id: string;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  step: string;
  qb_txn_id?: string | null;
};

/**
 * Re-submits a pipeline row that was coalesced while in-flight, or a pending row
 * picked up by the dispatch pass. Called after claimAndResetForResubmit confirms
 * a next_payload was present, or by the pending-dispatch and wake-dependents passes.
 */
export async function resubmitByStep(
  row: ResubmitRow,
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

      case "sales_receipt": {
        // Read full payload from row if present (qb-invoice-waiting-gate
        // and POS flow store invoice_id, items, payment_method etc). Falls
        // back to just {id} which handleSalesReceiptCreated supports.
        if (!row.order_id) break;
        const srPool = getDbPool();
        const srRow = await srPool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const srPayload = srRow.rows[0]?.payload as Record<string, unknown> | null;
        const eventData =
          srPayload && Object.keys(srPayload).length > 0
            ? { id: row.order_id, ...srPayload }
            : { id: row.order_id };
        await handleSalesReceiptCreated(
          eventData as any,
          orderModule,
          customerModule,
          container,
          logger
        );
        break;
      }

      case "invoice": {
        // Read full payload from row if present (fulfillment_id, items,
        // invoice_id, payment_method etc) and merge into event data. Falls
        // back to just {order_id} which handleFulfillmentCreated supports.
        if (!row.order_id) break;
        const invPool = getDbPool();
        const invRow = await invPool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const invPayload = invRow.rows[0]?.payload as Record<string, unknown> | null;
        const fulfillData =
          invPayload && Object.keys(invPayload).length > 0
            ? { order_id: row.order_id, ...invPayload }
            : { order_id: row.order_id };
        await handleFulfillmentCreated(
          fulfillData as any,
          orderModule,
          customerModule,
          container,
          logger
        );
        break;
      }

      case "invoice_update":
      case "sales_receipt_update": {
        if (!row.reference_id) break;
        const updatePool = getDbPool();
        const updateRow = await updatePool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const payload = (updateRow.rows[0]?.payload ?? {}) as Record<string, unknown>;
        const txnId = (payload.txnId as string | undefined) ?? row.qb_txn_id ?? null;
        if (!txnId) {
          await failPipelineRow(row.id, `${row.step}: missing QB TxnID`);
          break;
        }
        const modResult =
          row.step === "sales_receipt_update"
            ? await updateSalesReceiptInQb({ ...payload, txnId } as any)
            : await updateInvoiceInQb({ ...payload, txnId } as any);

        if (modResult.success && modResult.data?.operationId) {
          await updatePool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted',
                    bridge_op_id = $2,
                    qb_txn_id = $3,
                    submitted_at = NOW(),
                    updated_at = NOW()
              WHERE id = $1`,
            [row.id, modResult.data.operationId, txnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ ${row.step} ${row.id} submitted op=${modResult.data.operationId} txn=${txnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            modResult.error ?? `${row.step} update failed`
          );
        }
        break;
      }

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
        const payloadRes = await applyPool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const payload = payloadRes.rows[0]?.payload as
          | Record<string, unknown>
          | null;
        const { rows: appRows } = await applyPool.query(
          `SELECT payment_id, invoice_id, order_id, amount_applied
           FROM payment_application
           WHERE (id = $1 OR payment_id = $1)
             AND (order_id = $2 OR $2 IS NULL)
             AND voided_at IS NULL
           LIMIT 1`,
          [row.reference_id, row.order_id ?? null]
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
              payment_id: appRow.payment_id,
              invoice_id:
                (payload?.invoice_id as string | undefined) ??
                appRow.invoice_id ??
                null,
              order_id: appRow.order_id ?? row.order_id,
              amount_applied: appRow.amount_applied ?? 0,
              application_id:
                (payload?.application_id as string | undefined) ??
                row.reference_id,
            },
          },
          container,
        } as any);
        break;
      }

      case "estimate_cancel": {
        // Cancel an existing QB Estimate. The estimate must already have been
        // synced (qb_estimate.txn_id present in order metadata).
        if (!row.order_id) break;
        const orderForCancel = (await orderModule.retrieveOrder(row.order_id, {
          select: ["id", "metadata"],
        } as any)) as any;
        const estTxnId =
          orderForCancel?.metadata?.qb_estimate?.txn_id ?? null;
        if (!estTxnId) {
          await failPipelineRow(
            row.id,
            "estimate_cancel: no qb_estimate.txn_id in order metadata — nothing to cancel"
          );
          break;
        }
        const cancelResult = await cancelEstimateInQb(
          estTxnId,
          (m: string) => logger.info(m)
        );
        if (cancelResult.success && cancelResult.data?.operationId) {
          const cancelPool = getDbPool();
          await cancelPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, cancelResult.data.operationId, estTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ estimate_cancel ${row.id} submitted op=${cancelResult.data.operationId} txn=${estTxnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            cancelResult.error ?? "cancelEstimateInQb failed"
          );
        }
        break;
      }

      case "credit_memo_mod": {
        // Modify an existing QB Credit Memo. CM must already have been synced
        // (pos_credit_memo.qb_txn_id + qb_edit_sequence both present).
        if (!row.reference_id) break;
        const cmModPool = getDbPool();
        const cmRow = await cmModPool.query(
          `SELECT cm.qb_txn_id, cm.qb_edit_sequence, p.payload
             FROM qb_order_pipeline p
             JOIN pos_credit_memo cm ON cm.id = p.reference_id
            WHERE p.id = $1`,
          [row.id]
        );
        const cm = cmRow.rows[0];
        if (!cm?.qb_txn_id) {
          await failPipelineRow(
            row.id,
            "credit_memo_mod: pos_credit_memo has no qb_txn_id — was it synced?"
          );
          break;
        }
        if (!cm?.qb_edit_sequence) {
          await failPipelineRow(
            row.id,
            "credit_memo_mod: pos_credit_memo has no qb_edit_sequence — query QB first"
          );
          break;
        }
        const modPayload = (cm.payload ?? {}) as {
          salesRepRef?: string;
          salesTaxCode?: string;
          qbTaxItemListid?: string;
          taxExempt?: boolean;
          memo?: string;
        };
        const modResult = await updateCreditMemoInQb({
          txnId: cm.qb_txn_id,
          editSequence: cm.qb_edit_sequence,
          salesRepRef: modPayload.salesRepRef,
          salesTaxCode: modPayload.salesTaxCode,
          qbTaxItemListid: modPayload.qbTaxItemListid,
          taxExempt: modPayload.taxExempt,
          memo: modPayload.memo,
        });
        if (modResult.success && modResult.data?.operationId) {
          await cmModPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, modResult.data.operationId, cm.qb_txn_id]
          );
          logger.info(
            `${LOG_PREFIX} ✅ credit_memo_mod ${row.id} submitted op=${modResult.data.operationId} txn=${cm.qb_txn_id}`
          );
        } else {
          await failPipelineRow(
            row.id,
            modResult.error ?? "updateCreditMemoInQb failed"
          );
        }
        break;
      }

      case "payment": {
        // Pending payment receive — caller enqueues with payment_id (in row.reference_id).
        if (!row.reference_id) break;
        const handlePosPaymentCreated =
          require("../handlers/handle-pos-payment-created").handlePosPaymentCreated;
        await handlePosPaymentCreated({
          event: {
            name: "pos.payment.created",
            data: {
              id: row.reference_id,
              order_id: row.order_id,
            },
          },
          container,
        } as any);
        break;
      }

      case "credit_memo": {
        // Pending CM create — handler/admin enqueues with payload.
        if (!row.reference_id) break;
        const cmCreatePool = getDbPool();
        const cmCreateRow = await cmCreatePool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const cmCreatePayload = (cmCreateRow.rows[0]?.payload ?? {}) as any;
        if (!cmCreatePayload || Object.keys(cmCreatePayload).length === 0) {
          await failPipelineRow(
            row.id,
            "credit_memo: payload missing — cannot create"
          );
          break;
        }
        const cmCreateResult = await createCreditMemoInQb(cmCreatePayload);
        if (cmCreateResult.success && cmCreateResult.data?.operationId) {
          await cmCreatePool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, cmCreateResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ credit_memo ${row.id} submitted op=${cmCreateResult.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            cmCreateResult.error ?? "createCreditMemoInQb failed"
          );
        }
        break;
      }

      case "void_credit_memo": {
        if (!row.qb_txn_id) {
          await failPipelineRow(
            row.id,
            "void_credit_memo: missing qb_txn_id — cannot void"
          );
          break;
        }
        const voidCmPool = getDbPool();
        const voidCmRow = await voidCmPool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const voidCmPayload = (voidCmRow.rows[0]?.payload ?? {}) as {
          editSequence?: string;
        };
        const vcResult = await voidCreditMemoInQb(
          row.qb_txn_id,
          voidCmPayload.editSequence ?? null,
          (m: string) => logger.info(m)
        );
        if (vcResult.success && vcResult.data?.operationId) {
          await voidCmPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, vcResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_credit_memo ${row.id} submitted op=${vcResult.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            vcResult.error ?? "voidCreditMemoInQb failed"
          );
        }
        break;
      }

      case "void_invoice":
      case "void_sales_receipt": {
        if (!row.qb_txn_id) {
          await failPipelineRow(
            row.id,
            `${row.step}: missing qb_txn_id — cannot void`
          );
          break;
        }
        const voidResult =
          row.step === "void_sales_receipt"
            ? await voidSalesReceiptInQb(row.qb_txn_id, (m: string) =>
                logger.info(m)
              )
            : await voidInvoiceInQb(row.qb_txn_id, (m: string) =>
                logger.info(m)
              );
        if (voidResult.success && voidResult.data?.operationId) {
          const voidPool = getDbPool();
          await voidPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, voidResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ ${row.step} ${row.id} submitted op=${voidResult.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            voidResult.error ??
              `${row.step === "void_sales_receipt" ? "voidSalesReceiptInQb" : "voidInvoiceInQb"} failed`
          );
        }
        break;
      }

      case "void_sales_order": {
        let soTxnId = row.qb_txn_id ?? null;
        if (!soTxnId && row.order_id) {
          const soPool = getDbPool();
          const { rows: soRows } = await soPool.query(
            `SELECT qb_txn_id
               FROM qb_order_pipeline
              WHERE order_id = $1
                AND step IN ('estimate', 'sales_order')
                AND status = 'confirmed'
                AND qb_txn_id IS NOT NULL
              ORDER BY confirmed_at DESC
              LIMIT 1`,
            [row.order_id]
          );
          soTxnId = soRows[0]?.qb_txn_id ?? null;
        }

        if (!soTxnId) {
          await failPipelineRow(
            row.id,
            "void_sales_order: missing qb_txn_id — cannot close sales order"
          );
          break;
        }

        const closeResult = await closeSalesOrderInQb(soTxnId, (m: string) =>
          logger.info(m)
        );
        if (closeResult.success && closeResult.data?.operationId) {
          const soPool = getDbPool();
          await soPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, closeResult.data.operationId, soTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_sales_order ${row.id} submitted op=${closeResult.data.operationId} txn=${soTxnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            closeResult.error ?? "closeSalesOrderInQb failed"
          );
        }
        break;
      }

      case "void_check": {
        if (!row.qb_txn_id) {
          await failPipelineRow(
            row.id,
            "void_check: missing qb_txn_id — cannot void"
          );
          break;
        }
        const checkResult = await voidCheckInQb(row.qb_txn_id);
        if (checkResult.success && checkResult.data?.operationId) {
          const checkPool = getDbPool();
          await checkPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, checkResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_check ${row.id} submitted op=${checkResult.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            checkResult.error ?? "voidCheckInQb failed"
          );
        }
        break;
      }

      case "so_close":
      case "so_reopen": {
        if (!row.order_id) break;
        const isClose = row.step === "so_close";
        const orderForClose = (await orderModule.retrieveOrder(row.order_id, {
          select: ["id", "metadata"],
        } as any)) as any;
        const soTxnId =
          orderForClose?.metadata?.qb_sales_order?.txn_id ?? null;
        if (!soTxnId) {
          await failPipelineRow(
            row.id,
            `${row.step}: no qb_sales_order.txn_id in order metadata — nothing to ${isClose ? "close" : "reopen"}`
          );
          break;
        }
        const closeResult = isClose
          ? await closeSalesOrderInQb(soTxnId, (m: string) => logger.info(m))
          : await reopenSalesOrderInQb(soTxnId, (m: string) => logger.info(m));
        if (closeResult.success && closeResult.data?.operationId) {
          const closePool = getDbPool();
          await closePool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, closeResult.data.operationId, soTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ ${row.step} ${row.id} submitted op=${closeResult.data.operationId} txn=${soTxnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            closeResult.error ??
              `${isClose ? "closeSalesOrderInQb" : "reopenSalesOrderInQb"} failed`
          );
        }
        break;
      }

      case "transfer_customer": {
        if (!row.reference_id) break;
        const transferPool = getDbPool();
        const transferRow = await transferPool.query(
          `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const tPayload = (transferRow.rows[0]?.payload ?? {}) as {
          docType?: "sales-order" | "invoice";
          txnId?: string;
          editSequence?: string;
          newCustomerId?: string;
        };
        if (
          !tPayload.docType ||
          !tPayload.txnId ||
          !tPayload.editSequence ||
          !tPayload.newCustomerId
        ) {
          await failPipelineRow(
            row.id,
            `transfer_customer: payload incomplete (docType=${tPayload.docType}, txnId=${!!tPayload.txnId}, editSequence=${!!tPayload.editSequence}, newCustomerId=${!!tPayload.newCustomerId})`
          );
          break;
        }
        const transferResult = await transferDocumentCustomer(
          tPayload.docType,
          tPayload.txnId,
          tPayload.editSequence,
          tPayload.newCustomerId,
          (m: string) => logger.info(m)
        );
        if (transferResult.success && transferResult.data?.operationId) {
          await transferPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, transferResult.data.operationId, tPayload.txnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ transfer_customer ${row.id} (${tPayload.docType}) submitted op=${transferResult.data.operationId} txn=${tPayload.txnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            transferResult.error ??
              `transferDocumentCustomer failed for ${tPayload.docType} ${tPayload.txnId}`
          );
        }
        break;
      }

      default:
        logger.info(
          `${LOG_PREFIX} ℹ️ Coalesced resubmit for step=${row.step} — row reset to pending, will be picked up by next cron`
        );
    }
  } catch (err: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ resubmitByStep failed for row ${row.id} (${row.step}): ${err.message}`
    );
    await failPipelineRow(row.id, err.message || "resubmitByStep failed");
  }
}
