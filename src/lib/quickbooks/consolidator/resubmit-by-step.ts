import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  cancelEstimateInQb,
  deactivateEstimateInQb,
} from "../client/estimates";
import {
  updatePaymentTxnDateInQb,
  updatePaymentMethodInQb,
} from "../client/payments";
import { resolveQbPaymentMethodForPayment } from "../payment-method-sanitizer";
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
import { updateCheckInQb, voidCheckInQb } from "../client/checks";
import {
  postInventoryAdjustmentToQb,
  voidInventoryAdjustmentInQb,
  type AdjustmentGroupPayload,
} from "../client/inventory-adjustments";
import { handleDraftOrderUpdated } from "../handlers/handle-draft-order-updated";
import { handleFulfillmentCreated } from "../handlers/handle-fulfillment-created";
import { handleOrderPlaced } from "../handlers/handle-order-placed";
import { handleOrderUpdated } from "../handlers/handle-order-updated";
import { handlePaymentCustomerTransfer } from "../handlers/handle-payment-customer-transfer";
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
          // Distinguish "application was voided" (→ skip permanently) from
          // "genuinely missing" (→ warn only, leave for a later tick). An
          // apply_payment whose application got voided (e.g. the invoice was
          // voided, unapplying the payment) will NEVER have anything to apply;
          // without this it churns 'processing' forever. (Fixed 2026-07-01.)
          const { rows: voidedApp } = await applyPool.query(
            `SELECT id FROM payment_application
             WHERE (id = $1 OR payment_id = $1)
               AND (order_id = $2 OR $2 IS NULL)
               AND voided_at IS NOT NULL
             LIMIT 1`,
            [row.reference_id, row.order_id ?? null]
          );
          if (voidedApp.length > 0) {
            await applyPool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'skipped',
                      error = 'apply_payment: payment_application voided (nothing to apply) — auto-skipped',
                      updated_at = NOW()
                WHERE id = $1`,
              [row.id]
            );
            logger.info(
              `${LOG_PREFIX} ⏭️ apply_payment row ${row.id} skipped — application voided (ref=${row.reference_id})`
            );
          } else {
            logger.warn(
              `${LOG_PREFIX} ⚠️ No payment_application found for apply_payment row ${row.id} (ref=${row.reference_id})`
            );
          }
          break;
        }
        // DEPLOY-WINDOW SAFETY NET (deploy-window-proof dual-key guard):
        // If THIS row is keyed by customer_payment/payment (cpay_) — e.g. it was
        // written by a stale pre-fix build during a Railway deploy cutover — and a
        // canonical payment_application (papp_) sibling for the same
        // (payment_id, invoice_id) is already in-flight or confirmed, dispatching
        // this row would fire a SECOND ReceivePaymentMod against the same QB
        // ReceivePayment → the loser fails QB 3200 "stale edit sequence". Skip it.
        // Runs on the CURRENT build regardless of which build wrote the row, so it
        // neutralizes the only harmful symptom of the deploy-window race.
        if (row.reference_type !== "payment_application") {
          const invoiceIdForSibling =
            (payload?.invoice_id as string | undefined) ??
            appRow.invoice_id ??
            null;
          if (invoiceIdForSibling) {
            const { rows: papSibling } = await applyPool.query(
              `SELECT p.id
                 FROM qb_order_pipeline p
                 JOIN payment_application pa ON pa.id = p.reference_id
                WHERE p.step = 'apply_payment'
                  AND p.reference_type = 'payment_application'
                  AND p.status IN ('processing', 'submitted', 'confirmed')
                  AND pa.payment_id = $1
                  AND pa.invoice_id = $2
                LIMIT 1`,
              [appRow.payment_id, invoiceIdForSibling]
            );
            if (papSibling.length > 0) {
              await applyPool.query(
                `UPDATE qb_order_pipeline
                    SET status = 'skipped',
                        error = 'apply_payment: superseded by payment_application (papp_) sibling row — dual-key duplicate suppressed',
                        updated_at = NOW()
                  WHERE id = $1`,
                [row.id]
              );
              logger.info(
                `${LOG_PREFIX} ⏭️ apply_payment row ${row.id} skipped — papp_ sibling ${papSibling[0].id} already in-flight/confirmed (cpay_ dual-key suppressed, ref=${row.reference_id})`
              );
              break;
            }
          }
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

      case "estimate_deactivate": {
        // Deactivate (IsActive=false) the QB Estimate that was converted into
        // this order's Sales Order. QBXML has no SO↔Estimate link, so the SO is
        // rebuilt from scratch and the original Estimate would otherwise linger
        // as "open"; we close it here so it drops out of QB's Open Estimates
        // list. Line amounts are PRESERVED (deactivate, not cancel/zero-out) so
        // the historical estimate stays intact. txnId rides on the pipeline row.
        const estDeactTxnId = row.qb_txn_id ?? null;
        if (!estDeactTxnId) {
          await failPipelineRow(
            row.id,
            "estimate_deactivate: row has no qb_txn_id — nothing to deactivate"
          );
          break;
        }
        const deactResult = await deactivateEstimateInQb(
          estDeactTxnId,
          undefined,
          (m: string) => logger.info(m)
        );
        if (deactResult.success && deactResult.data?.operationId) {
          const deactPool = getDbPool();
          await deactPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      qb_txn_id = $3,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, deactResult.data.operationId, estDeactTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ estimate_deactivate ${row.id} submitted op=${deactResult.data.operationId} txn=${estDeactTxnId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            deactResult.error ?? "deactivateEstimateInQb failed"
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
          customerId?: string;
          date?: string;
          refNumber?: string;
          items?: Array<Record<string, unknown>>;
        };
        const modResult = await updateCreditMemoInQb({
          txnId: cm.qb_txn_id,
          editSequence: cm.qb_edit_sequence,
          salesRepRef: modPayload.salesRepRef,
          salesTaxCode: modPayload.salesTaxCode,
          qbTaxItemListid: modPayload.qbTaxItemListid,
          taxExempt: modPayload.taxExempt,
          memo: modPayload.memo,
          customerId: modPayload.customerId,
          date: modPayload.date,
          refNumber: modPayload.refNumber,
          items: modPayload.items as any,
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
        // Idempotency key keyed on the CM id — a re-dispatch of this same create
        // (manual resync, lost response) dedupes at the bridge instead of minting
        // a duplicate QB Credit Memo. Stable across re-dispatches of this row.
        const cmCreateResult = await createCreditMemoInQb({
          ...cmCreatePayload,
          idempotencyKey: `credit-memo:${row.reference_id}`,
        });
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

      case "transfer_payment": {
        if (!row.reference_id) {
          await failPipelineRow(
            row.id,
            "transfer_payment: missing reference_id (payment id)"
          );
          break;
        }
        await handlePaymentCustomerTransfer(
          { id: row.id, reference_id: row.reference_id },
          container,
          logger
        );
        break;
      }

      case "payment_txndate_change": {
        // batch_day edit → move the QB doc's TxnDate. Reads the LIVE
        // customer_payment.batch_day (never a stale payload) so repeated edits
        // coalesce into the latest value and QB always converges — out-of-order
        // dispatches are harmless.
        if (!row.reference_id) {
          await failPipelineRow(
            row.id,
            "payment_txndate_change: missing reference_id (payment id)"
          );
          break;
        }
        const txnDatePool = getDbPool();
        const { rows: payRows } = await txnDatePool.query(
          `SELECT batch_day, status, metadata
             FROM customer_payment
            WHERE id = $1 AND deleted_at IS NULL`,
          [row.reference_id]
        );
        const pay = payRows[0] as
          | {
              batch_day: string | null;
              status: string;
              metadata: Record<string, unknown> | null;
            }
          | undefined;

        const skipTxnDateRow = async (reason: string) => {
          await txnDatePool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped', error = $2, updated_at = NOW()
              WHERE id = $1`,
            [row.id, reason]
          );
          logger.info(
            `${LOG_PREFIX} ⏭️ payment_txndate_change ${row.id} skipped: ${reason}`
          );
        };

        if (!pay || !pay.batch_day) {
          await skipTxnDateRow("payment missing or has no batch_day");
          break;
        }
        if (pay.status === "voided") {
          await skipTxnDateRow("payment is voided — no QB doc to move");
          break;
        }

        const payMeta = pay.metadata ?? {};
        const isSrEmbedded =
          payMeta.is_sales_receipt_payment === true ||
          payMeta.qb_source === "sales_receipt";

        if (isSrEmbedded) {
          // SR-embedded: the payment and the sale are ONE Sales Receipt —
          // move the whole doc's TxnDate (user-confirmed; SR is standalone,
          // no LinkToTxn risk).
          const srOrderId =
            (payMeta.order_id as string | undefined) ?? row.order_id ?? null;
          if (!srOrderId) {
            await skipTxnDateRow("SR-embedded payment has no order_id");
            break;
          }
          const { rows: srRows } = await txnDatePool.query(
            `SELECT qb_txn_id FROM qb_order_pipeline
              WHERE order_id = $1 AND step = 'sales_receipt' AND status = 'confirmed'
              ORDER BY created_at DESC LIMIT 1`,
            [srOrderId]
          );
          const srTxnId = srRows[0]?.qb_txn_id as string | undefined;
          if (!srTxnId) {
            // SR create may still be in flight — fail (retryable) instead of skip.
            await failPipelineRow(
              row.id,
              `payment_txndate_change: no confirmed sales_receipt row for order ${srOrderId}`
            );
            break;
          }
          const srMod = await updateSalesReceiptInQb({
            txnId: srTxnId,
            date: pay.batch_day,
          });
          if (srMod.success && srMod.data?.operationId) {
            await txnDatePool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                      submitted_at = NOW(), updated_at = NOW()
                WHERE id = $1`,
              [row.id, srMod.data.operationId, srTxnId]
            );
            logger.info(
              `${LOG_PREFIX} ✅ payment_txndate_change ${row.id} → SalesReceiptMod ${srTxnId} TxnDate=${pay.batch_day} op=${srMod.data.operationId}`
            );
          } else {
            await failPipelineRow(
              row.id,
              srMod.error ?? "SalesReceiptMod for TxnDate failed"
            );
          }
          break;
        }

        // Regular standalone ReceivePayment
        const payTxnId = payMeta.qb_txn_id as string | undefined;
        if (!payTxnId || payTxnId === "SYNCED_VIA_RECEIPT") {
          await skipTxnDateRow(
            "payment has no standalone QB ReceivePayment TxnID"
          );
          break;
        }
        const payMod = await updatePaymentTxnDateInQb(
          payTxnId,
          pay.batch_day,
          (m: string) => logger.info(m)
        );
        if (payMod.success && payMod.data?.operationId) {
          await txnDatePool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                    submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, payMod.data.operationId, payTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ payment_txndate_change ${row.id} → ReceivePaymentMod ${payTxnId} TxnDate=${pay.batch_day} op=${payMod.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            payMod.error ?? "ReceivePaymentMod for TxnDate failed"
          );
        }
        break;
      }

      case "payment_method_change": {
        // Payment method edit → move the QB doc's PaymentMethodRef. Reads the
        // LIVE customer_payment.method/card_brand (never a stale payload) so
        // repeated edits coalesce into the latest value — same convergence
        // model as payment_txndate_change/refund_check_mod.
        if (!row.reference_id) {
          await failPipelineRow(
            row.id,
            "payment_method_change: missing reference_id (payment id)"
          );
          break;
        }
        const pmcPool = getDbPool();

        const skipPmcRow = async (reason: string) => {
          await pmcPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped', error = $2, updated_at = NOW()
              WHERE id = $1`,
            [row.id, reason]
          );
          logger.info(
            `${LOG_PREFIX} ⏭️ payment_method_change ${row.id} skipped: ${reason}`
          );
        };

        const { rows: pmcRows } = await pmcPool.query(
          `SELECT method, card_brand, status, metadata
             FROM customer_payment
            WHERE id = $1 AND deleted_at IS NULL`,
          [row.reference_id]
        );
        const pmcPay = pmcRows[0] as
          | {
              method: string | null;
              card_brand: string | null;
              status: string;
              metadata: Record<string, unknown> | null;
            }
          | undefined;

        if (!pmcPay) {
          await skipPmcRow("customer_payment not found");
          break;
        }
        if (pmcPay.status === "voided") {
          await skipPmcRow("payment is voided — no QB doc to move");
          break;
        }

        const pmcMeta = pmcPay.metadata ?? {};
        const qbMethodName =
          resolveQbPaymentMethodForPayment(pmcPay.method, pmcPay.card_brand) ??
          (pmcMeta.pos_payment_method as string | undefined) ??
          pmcPay.method ??
          undefined;
        if (!qbMethodName) {
          await skipPmcRow("could not resolve a QB payment method");
          break;
        }

        const isSrEmbedded =
          pmcMeta.is_sales_receipt_payment === true ||
          pmcMeta.qb_source === "sales_receipt";

        if (isSrEmbedded) {
          const srOrderId =
            (pmcMeta.order_id as string | undefined) ?? row.order_id ?? null;
          if (!srOrderId) {
            await skipPmcRow("SR-embedded payment has no order_id");
            break;
          }
          const { rows: srRows } = await pmcPool.query(
            `SELECT qb_txn_id FROM qb_order_pipeline
              WHERE order_id = $1 AND step = 'sales_receipt' AND status = 'confirmed'
              ORDER BY created_at DESC LIMIT 1`,
            [srOrderId]
          );
          const srTxnId = srRows[0]?.qb_txn_id as string | undefined;
          if (!srTxnId) {
            // SR create may still be in flight — fail (retryable) instead of skip.
            await failPipelineRow(
              row.id,
              `payment_method_change: no confirmed sales_receipt row for order ${srOrderId}`
            );
            break;
          }
          const srMod = await updateSalesReceiptInQb({
            txnId: srTxnId,
            paymentMethod: qbMethodName,
          });
          if (srMod.success && srMod.data?.operationId) {
            await pmcPool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                      submitted_at = NOW(), updated_at = NOW()
                WHERE id = $1`,
              [row.id, srMod.data.operationId, srTxnId]
            );
            logger.info(
              `${LOG_PREFIX} ✅ payment_method_change ${row.id} → SalesReceiptMod ${srTxnId} PaymentMethod=${qbMethodName} op=${srMod.data.operationId}`
            );
          } else {
            await failPipelineRow(
              row.id,
              srMod.error ?? "SalesReceiptMod for PaymentMethod failed"
            );
          }
          break;
        }

        // Regular standalone ReceivePayment
        const payTxnId =
          (pmcMeta.qb_txn_id as string | undefined) ??
          row.qb_txn_id ??
          undefined;
        if (!payTxnId || payTxnId === "SYNCED_VIA_RECEIPT") {
          await skipPmcRow(
            "payment has no standalone QB ReceivePayment TxnID"
          );
          break;
        }
        const payMod = await updatePaymentMethodInQb(
          payTxnId,
          qbMethodName,
          (m: string) => logger.info(m)
        );
        if (payMod.success && payMod.data?.operationId) {
          await pmcPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                    submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, payMod.data.operationId, payTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ payment_method_change ${row.id} → ReceivePaymentMod ${payTxnId} PaymentMethod=${qbMethodName} op=${payMod.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            payMod.error ?? "ReceivePaymentMod for PaymentMethod failed"
          );
        }
        break;
      }

      case "refund_check_mod": {
        // Edit of a CONFIRMED refund Write Check: bank and/or refund date.
        // Desired state is read LIVE at dispatch — the date from
        // customer_payment (metadata.refund_txn_date › batch_day), the bank
        // from this row's payload — so repeated edits coalesce into the latest
        // value (same convergence model as payment_txndate_change). CheckMod
        // is header-only (bridge emits no line elements → AR expense line
        // preserved) and safe to re-dispatch.
        if (!row.reference_id) {
          await failPipelineRow(
            row.id,
            "refund_check_mod: missing reference_id (payment id)"
          );
          break;
        }
        const rcmPool = getDbPool();

        const skipRcmRow = async (reason: string) => {
          await rcmPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped', error = $2, updated_at = NOW()
              WHERE id = $1`,
            [row.id, reason]
          );
          logger.info(
            `${LOG_PREFIX} ⏭️ refund_check_mod ${row.id} skipped: ${reason}`
          );
        };

        const { rows: rcmCpRows } = await rcmPool.query(
          `SELECT status, batch_day, metadata
             FROM customer_payment
            WHERE id = $1 AND deleted_at IS NULL`,
          [row.reference_id]
        );
        const rcmCp = rcmCpRows[0] as
          | {
              status: string;
              batch_day: string | null;
              metadata: Record<string, unknown> | null;
            }
          | undefined;
        if (!rcmCp) {
          await skipRcmRow("customer_payment not found");
          break;
        }
        if (rcmCp.status === "voided") {
          await skipRcmRow("refund is voided — nothing to edit in QB");
          break;
        }

        // Row payload + check TxnID (row.qb_txn_id set at enqueue; fall back
        // to the confirmed write_check row).
        const { rows: rcmSelfRows } = await rcmPool.query(
          `SELECT payload, qb_txn_id FROM qb_order_pipeline WHERE id = $1`,
          [row.id]
        );
        const rcmPayload = (rcmSelfRows[0]?.payload ?? {}) as {
          bankAccountId?: string;
        };
        let checkTxnId = rcmSelfRows[0]?.qb_txn_id as string | null;
        if (!checkTxnId) {
          const { rows: wcTxnRows } = await rcmPool.query(
            `SELECT qb_txn_id FROM qb_order_pipeline
              WHERE step = 'write_check' AND reference_id = $1
                AND status = 'confirmed' AND qb_txn_id IS NOT NULL
              ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
            [row.reference_id]
          );
          checkTxnId = wcTxnRows[0]?.qb_txn_id ?? null;
        }
        if (!checkTxnId) {
          await failPipelineRow(
            row.id,
            "refund_check_mod: no confirmed write_check TxnID"
          );
          break;
        }

        const desiredDate =
          ((rcmCp.metadata?.refund_txn_date as string | undefined) ??
            rcmCp.batch_day) ||
          undefined;

        let bankListId: string | undefined;
        if (rcmPayload.bankAccountId) {
          const { rows: bankRows } = await rcmPool.query(
            `SELECT list_id, type, name FROM qb_bank_account WHERE id = $1`,
            [rcmPayload.bankAccountId]
          );
          const bankRow = bankRows[0];
          if (!bankRow || bankRow.type !== "Bank" || !bankRow.list_id) {
            await failPipelineRow(
              row.id,
              `refund_check_mod: bank account ${rcmPayload.bankAccountId} missing or not type Bank`
            );
            break;
          }
          bankListId = bankRow.list_id as string;
        }

        if (!desiredDate && !bankListId) {
          await skipRcmRow("nothing to change (no date, no bank)");
          break;
        }

        const checkMod = await updateCheckInQb(checkTxnId, {
          date: desiredDate,
          bankAccountListId: bankListId,
        });
        if (checkMod.success && checkMod.data?.operationId) {
          await rcmPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                    submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, checkMod.data.operationId, checkTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ refund_check_mod ${row.id} → CheckMod ${checkTxnId} date=${desiredDate ?? "unchanged"} bank=${bankListId ?? "unchanged"} op=${checkMod.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            checkMod.error ?? "CheckMod failed"
          );
        }
        break;
      }

      case "refund_payment_txndate_change": {
        // Date-only mod of the $0 apply ReceivePayment of a refund. Reads the
        // LIVE refund date and the LIVE refund_payment row: waiting → just
        // rewrite its payload (the create will carry the date); in flight →
        // fail-retryable until it confirms; confirmed → ReceivePaymentMod.
        if (!row.reference_id) {
          await failPipelineRow(
            row.id,
            "refund_payment_txndate_change: missing reference_id (payment id)"
          );
          break;
        }
        const rptPool = getDbPool();

        const skipRptRow = async (reason: string) => {
          await rptPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped', error = $2, updated_at = NOW()
              WHERE id = $1`,
            [row.id, reason]
          );
          logger.info(
            `${LOG_PREFIX} ⏭️ refund_payment_txndate_change ${row.id} skipped: ${reason}`
          );
        };

        const { rows: rptCpRows } = await rptPool.query(
          `SELECT status, batch_day, metadata
             FROM customer_payment
            WHERE id = $1 AND deleted_at IS NULL`,
          [row.reference_id]
        );
        const rptCp = rptCpRows[0] as
          | {
              status: string;
              batch_day: string | null;
              metadata: Record<string, unknown> | null;
            }
          | undefined;
        if (!rptCp) {
          await skipRptRow("customer_payment not found");
          break;
        }
        if (rptCp.status === "voided") {
          await skipRptRow("refund is voided — nothing to move");
          break;
        }
        const rptDate =
          ((rptCp.metadata?.refund_txn_date as string | undefined) ??
            rptCp.batch_day) ||
          null;
        if (!rptDate) {
          await skipRptRow("payment has no refund date / batch_day");
          break;
        }

        const { rows: rptRpRows } = await rptPool.query(
          `SELECT id, status, qb_txn_id FROM qb_order_pipeline
            WHERE step = 'refund_payment' AND reference_id = $1
            ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
          [row.reference_id]
        );
        const rptRp = rptRpRows[0] as
          | { id: string; status: string; qb_txn_id: string | null }
          | undefined;
        if (!rptRp) {
          await skipRptRow("no refund_payment row for this refund");
          break;
        }
        if (rptRp.status === "waiting") {
          await rptPool.query(
            `UPDATE qb_order_pipeline
                SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
                    updated_at = NOW()
              WHERE id = $1`,
            [rptRp.id, JSON.stringify({ txnDate: rptDate })]
          );
          await skipRptRow(
            "refund_payment still waiting — payload.txnDate updated, create will carry the date"
          );
          break;
        }
        if (rptRp.status === "confirmed" && !rptRp.qb_txn_id) {
          // Legacy confirms didn't store the $0 ReceivePayment TxnID — nothing
          // to target. Skip (NOT fail: retrying can never resolve it → churn).
          await skipRptRow(
            "refund_payment confirmed but has no qb_txn_id (legacy row) — cannot move its date"
          );
          break;
        }
        if (rptRp.status !== "confirmed" || !rptRp.qb_txn_id) {
          await failPipelineRow(
            row.id,
            `refund_payment_txndate_change: apply ReceivePayment not confirmed yet (status=${rptRp.status})`
          );
          break;
        }

        const rptMod = await updatePaymentTxnDateInQb(
          rptRp.qb_txn_id,
          rptDate,
          (m: string) => logger.info(m)
        );
        if (rptMod.success && rptMod.data?.operationId) {
          await rptPool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3,
                    submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, rptMod.data.operationId, rptRp.qb_txn_id]
          );
          logger.info(
            `${LOG_PREFIX} ✅ refund_payment_txndate_change ${row.id} → ReceivePaymentMod ${rptRp.qb_txn_id} TxnDate=${rptDate} op=${rptMod.data.operationId}`
          );
        } else {
          await failPipelineRow(
            row.id,
            rptMod.error ?? "ReceivePaymentMod for refund apply date failed"
          );
        }
        break;
      }

      case "inventory_adjustment": {
        const pool = getDbPool();
        const iaRow = await pool.query(
          `SELECT p.payload, ic.stock_location_id
             FROM qb_order_pipeline p
             LEFT JOIN inventory_count ic ON ic.id = p.order_id
            WHERE p.id = $1`,
          [row.id]
        );
        const iaPayload = iaRow.rows[0]?.payload as AdjustmentGroupPayload | null;
        if (!iaPayload?.lines?.length) {
          await failPipelineRow(row.id, "inventory_adjustment: missing or empty payload");
          break;
        }

        // Always use the frozen payload from approval — new_stock is the absolute
        // quantity the count approved and what QB must be set to. Re-querying live
        // inventory on retry was wrong: sales/receipts between approval and retry
        // would cause QB to receive the current value, not the approved one.
        const iaResult = await postInventoryAdjustmentToQb(row.id, iaPayload, container, logger);
        if (iaResult.success) {
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, iaResult.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ inventory_adjustment ${row.id} submitted op=${iaResult.operationId}`
          );
        } else {
          await failPipelineRow(row.id, iaResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ inventory_adjustment ${row.id} failed: ${iaResult.error}`
          );
        }
        break;
      }

      case "void_inventory_adjustment": {
        if (!row.qb_txn_id) {
          await failPipelineRow(row.id, "void_inventory_adjustment: missing qb_txn_id");
          break;
        }
        const viaResult = await voidInventoryAdjustmentInQb(row.id, row.qb_txn_id);
        if (viaResult.success) {
          const pool = getDbPool();
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, viaResult.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_inventory_adjustment ${row.id} submitted op=${viaResult.operationId}`
          );
        } else {
          await failPipelineRow(row.id, viaResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ void_inventory_adjustment ${row.id} failed: ${viaResult.error}`
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
