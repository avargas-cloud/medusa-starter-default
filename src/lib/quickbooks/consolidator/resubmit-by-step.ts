import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { fetchDamageAdjustmentSnapshot } from "../damage/refresh-damage-snapshot";
import type { DamageAdjustmentAddPayload } from "../client/inventory-adjustments";
import {
  cancelEstimateInQb,
  deactivateEstimateInQb,
} from "../client/estimates";
import {
  updatePaymentTxnDateInQb,
  updatePaymentMethodInQb,
  voidPaymentInQb,
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
import {
  updateCheckInQb,
  voidCheckInQb,
  fetchCheckLinkedTxns,
} from "../client/checks";
import {
  postInventoryAdjustmentToQb,
  voidInventoryAdjustmentInQb,
  postDamageAdjustmentAddToQb,
  postDamageAdjustmentModToQb,
  type AdjustmentGroupPayload,
} from "../client/inventory-adjustments";
import { handleDraftOrderUpdated } from "../handlers/handle-draft-order-updated";
import { handleFulfillmentCreated } from "../handlers/handle-fulfillment-created";
import { handleOrderPlaced } from "../handlers/handle-order-placed";
import { handleOrderUpdated } from "../handlers/handle-order-updated";
import { handlePaymentCustomerTransfer } from "../handlers/handle-payment-customer-transfer";
import { handlePosPaymentApplied } from "../handlers/handle-pos-payment-applied";
import { handleSalesReceiptCreated } from "../handlers/handle-sales-receipt-created";
import {
  failOrRetryPipelineRow,
  failPipelineRow,
  skipPipelineRowById,
} from "../qb-pipeline";
import {
  describeBlockers,
  findVoidBlockers,
  hasWaitedTooLong,
  QUIESCENCE_MAX_WAIT_MS,
  QUIESCENCE_RECHECK_SECONDS,
  type QuiescenceBlocker,
} from "../pipeline/document-quiescence";
import { deferPipelineRow } from "../pipeline/row-mutations";
import { handleDraftOrderCreated } from "../../../subscribers/qb-draft-order-subscriber";
import {
  processCustomerPipelineRow,
  processCustomerDataExtPipelineRow,
} from "./customer-pass";
import { bridgeFetch } from "../client/core";
import {
  dispatchPurchaseOperation,
  mirrorPurchaseOperationFailure,
  PURCHASE_OPERATION_STEPS,
  refreshVendorBillModSnapshot,
} from "./purchase-operations";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

export type ResubmitRow = {
  id: string;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  step: string;
  qb_txn_id?: string | null;
  retry_count?: number | null;
  payload?: Record<string, unknown> | null;
};

/**
 * Gate de quiescencia para la familia VOID.
 *
 * Un void despachado mientras una mutación del mismo documento sigue encolada
 * la corre en carrera — el mismo patrón que mató a CM-1105 → Invoice 21215 con
 * QB 3210. Corre en CADA intento, justo antes del bridge: una respuesta
 * calculada al encolar ya estaría vieja.
 *
 * Devuelve `true` si el caller debe ABORTAR el dispatch. Nunca despacha a
 * ciegas al vencer el tope: falla visible, porque forzar un void contra un
 * documento que está cambiando cambia un bloqueo visible por un riesgo contable.
 */
async function voidBlockedByLiveMutation(
  row: ResubmitRow,
  logger: any
): Promise<boolean> {
  let blockers: QuiescenceBlocker[];
  try {
    blockers = await findVoidBlockers(getDbPool(), {
      voidStep: row.step,
      rowId: row.id,
      referenceId: row.reference_id,
      orderId: row.order_id,
    });
  } catch (qErr: any) {
    // El gate jamás puede ser el que rompe el pipeline: si falla, se loguea y
    // se despacha igual (el comportamiento previo a este gate).
    logger.warn(
      `${LOG_PREFIX} Quiescence check de ${row.step} falló (${qErr?.message}) — despachando sin él`
    );
    return false;
  }

  if (blockers.length === 0) return false;

  const detail = describeBlockers(blockers);
  const { deferredSince } = await deferPipelineRow(
    row.id,
    `⏸️ Esperando que asienten las ediciones en vuelo de QuickBooks: ${detail}`,
    QUIESCENCE_RECHECK_SECONDS
  );

  if (hasWaitedTooLong(deferredSince)) {
    const minutes = Math.round(QUIESCENCE_MAX_WAIT_MS / 60000);
    await failPipelineRow(
      row.id,
      `${row.step} esperó ${minutes}min por ediciones en vuelo de QB: ${detail}. ` +
        `NO se despachó — voidear un documento mientras cambia produce 3200/3210. ` +
        `Resolver esas operaciones y después Retry.`
    );
    logger.error(
      `${LOG_PREFIX} ⛔ ${row.step} ${row.id} se rindió tras ${minutes}min esperando a: ${detail}`
    );
  } else {
    logger.info(
      `${LOG_PREFIX} ⏸️ ${row.step} ${row.id} diferido — documento no quieto: ${detail}`
    );
  }
  return true;
}

/**
 * Retry-aware failure for the VOID/DEL step family (void_check,
 * refund_apply_del, void_invoice, …): transient errors (dead tunnel, fetch
 * failed, 3170 lock) land as status='failed' WITH next_retry_at so the
 * dispatch pass re-claims them with backoff, instead of the legacy dead-end
 * failed-with-NULL-next_retry_at that only a human could revive.
 */
async function failVoidFamilyRow(row: ResubmitRow, error: string) {
  await failOrRetryPipelineRow(row.id, error, Number(row.retry_count ?? 0));
}

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
      case "purchase_order_mod":
      case "item_receipt_add":
      case "item_receipt_mod":
      case "vendor_bill_add":
      case "vendor_bill_rebuild_preflight":
      case "vendor_bill_rebuild_delete": {
        const dispatched = await dispatchPurchaseOperation(row, logger);
        logger.info(
          `${LOG_PREFIX} ✅ ${row.step} ${row.id} submitted op=${dispatched.operationId}`
        );
        break;
      }

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
            // excludeRowId: THIS row is claimed 'processing' by us — without the
            // exclusion the handler detects it as its own in-flight ADD, parks a
            // phantom mod behind it and this row gets skipped as "Superseded"
            // while the CREATE never runs (the 2026-08-08..11 estimate deadlock).
            { isCron: true, awaitSerialized: true, excludeRowId: row.id }
          );
          if (outcome === "skipped") {
            await handleDraftOrderCreated(
              { id: row.order_id },
              container,
              logger,
              true // isCron — skips the 1h POS delay guard
            );
          } else {
            // Append-only lane: the MOD went out on (or parked as) its own
            // estimate_mod row — this legacy 'estimate' row was only the
            // vehicle that woke the consolidator. Settle it so it can't churn
            // processing→recovery forever.
            await skipPipelineRowById(
              row.id,
              "Superseded by append-only estimate_mod row",
              { includeProcessing: true }
            );
          }
        }
        break;

      case "estimate_mod": {
        if (!row.order_id) {
          await failPipelineRow(row.id, "estimate_mod: row has no order_id");
          break;
        }
        // Deterministic MOD — an estimate_mod row NEVER falls back to CREATE
        // (a mod that turns into an ADD mints a duplicate QB document). The
        // handler transitions THIS row by id (we already hold the claim).
        const outcome = await handleDraftOrderUpdated(
          row.order_id,
          container,
          logger,
          {
            isCron: true,
            awaitSerialized: true,
            pipelineRowId: row.id,
            excludeRowId: row.id,
          }
        );
        if (outcome === "skipped") {
          await failPipelineRow(
            row.id,
            "estimate_mod: no QB Estimate TxnID on order metadata — nothing to modify"
          );
        }
        break;
      }

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
            // excludeRowId: same self-detection guard as the estimate case above.
            { isCron: true, awaitSerialized: true, excludeRowId: row.id }
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
          } else {
            // Append-only lane: the MOD went out on (or parked as) its own
            // sales_order_mod row — settle this legacy vehicle row.
            await skipPipelineRowById(
              row.id,
              "Superseded by append-only sales_order_mod row",
              { includeProcessing: true }
            );
          }
        }
        break;

      case "sales_order_mod": {
        if (!row.order_id) {
          await failPipelineRow(row.id, "sales_order_mod: row has no order_id");
          break;
        }
        // Deterministic MOD — never falls back to CREATE. The handler
        // transitions THIS row by id (we already hold the claim).
        const outcome = await handleOrderUpdated(row.order_id, container, logger, {
          isCron: true,
          awaitSerialized: true,
          pipelineRowId: row.id,
          excludeRowId: row.id,
        });
        if (outcome === "skipped") {
          await failPipelineRow(
            row.id,
            "sales_order_mod: no QB Sales Order TxnID on order metadata — nothing to modify"
          );
        }
        break;
      }

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
              // This pass already claimed the row (FOR UPDATE SKIP LOCKED →
              // status 'processing') before calling. Telling the handler which
              // row we own stops its own claim from mistaking OUR lock for a
              // rival dispatcher's and refusing to dispatch at all.
              claimed_pipeline_row_id: row.id,
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
        if (await voidBlockedByLiveMutation(row, logger)) break;
        // Deactivate (IsActive=false) the QB Estimate that was converted into
        // this order's Sales Order. QBXML has no SO↔Estimate link, so the SO is
        // rebuilt from scratch and the original Estimate would otherwise linger
        // as "open"; we close it here so it drops out of QB's Open Estimates
        // list. Line amounts are PRESERVED (deactivate, not cancel/zero-out) so
        // the historical estimate stays intact. txnId rides on the pipeline row.
        let estDeactTxnId = row.qb_txn_id ?? null;
        // Rows chained via handleOrderCanceled (order voided while its Estimate
        // was still in-flight) are written without qb_txn_id — only depends_on.
        // If runWakeDependentsPass wakes this row before poll-submitted-rows'
        // targeted activation stamps qb_txn_id, resolve it here as a fallback.
        if (!estDeactTxnId && row.order_id) {
          const estPool = getDbPool();
          const { rows: estRows } = await estPool.query(
            `SELECT qb_txn_id
               FROM qb_order_pipeline
              WHERE order_id = $1
                AND step = 'estimate'
                AND status = 'confirmed'
                AND qb_txn_id IS NOT NULL
              ORDER BY confirmed_at DESC
              LIMIT 1`,
            [row.order_id]
          );
          estDeactTxnId = estRows[0]?.qb_txn_id ?? null;
        }
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
          /** Set by the 3290 line-order self-heal — see heal-line-order.ts. */
          qbLineOrder?: string[];
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
          qbLineOrder: modPayload.qbLineOrder,
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
        if (await voidBlockedByLiveMutation(row, logger)) break;
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
          await failVoidFamilyRow(
            row,
            vcResult.error ?? "voidCreditMemoInQb failed"
          );
        }
        break;
      }

      case "void_invoice":
      case "void_sales_receipt": {
        if (await voidBlockedByLiveMutation(row, logger)) break;
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
          await failVoidFamilyRow(
            row,
            voidResult.error ??
              `${row.step === "void_sales_receipt" ? "voidSalesReceiptInQb" : "voidInvoiceInQb"} failed`
          );
        }
        break;
      }

      case "void_sales_order": {
        if (await voidBlockedByLiveMutation(row, logger)) break;
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
          await failVoidFamilyRow(
            row,
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
          await failVoidFamilyRow(
            row,
            checkResult.error ?? "voidCheckInQb failed"
          );
        }
        break;
      }

      // Revert-refund cleanup: TxnDel the $0 apply ReceivePayment (QB has no
      // TxnVoid for ReceivePayment). Its confirm handler (poll-submitted-rows)
      // runs the Medusa revert and wakes the dependent void_check row.
      //
      // When qb_txn_id is unknown (the historic norm — QBXML quirk: a
      // zero-amount ReceivePaymentAdd applied entirely from credits may create
      // NO txn, its AddRs Ret has no TxnID), the row carries
      // payload.resolveVia='check_linked_txn': we query the CHECK with
      // IncludeLinkedTxns and (a) find a linked ReceivePayment → that's the
      // doc, delete it; (b) linked list present but no ReceivePayment → no $0
      // doc exists, skip this row and wake void_check (voiding the check alone
      // frees the credit); (c) no LinkedTxn key → bridge predates
      // IncludeLinkedTxns → retry-fail with a clear message.
      case "refund_apply_del": {
        let applyTxnId = row.qb_txn_id ?? null;
        const rpPayload = (row.payload ?? {}) as Record<string, unknown>;
        if (!applyTxnId && rpPayload.resolveVia === "check_linked_txn") {
          const checkTxnIdForResolve = String(rpPayload.checkTxnId ?? "");
          if (!checkTxnIdForResolve) {
            await failPipelineRow(
              row.id,
              "refund_apply_del: resolveVia=check_linked_txn but payload.checkTxnId missing"
            );
            break;
          }
          let linked: Awaited<ReturnType<typeof fetchCheckLinkedTxns>>;
          try {
            linked = await fetchCheckLinkedTxns(
              checkTxnIdForResolve,
              (m: string) => logger.info(m)
            );
          } catch (resolveErr: any) {
            // Bridge/network failure while resolving — transient: retry with
            // backoff instead of the dead-end generic catch.
            await failVoidFamilyRow(
              row,
              `refund_apply_del resolve failed: ${resolveErr.message ?? resolveErr}`
            );
            break;
          }
          if (linked === null) {
            await failVoidFamilyRow(
              row,
              "refund_apply_del: bridge returned no LinkedTxn (IncludeLinkedTxns not deployed on bridge yet) — update the bridge or clean up manually via confirm-qb-cleanup"
            );
            break;
          }
          const linkedRp = linked.find((l) => l.txnType === "ReceivePayment");
          if (!linkedRp) {
            // No $0 ReceivePayment doc exists in QB — the credit application
            // lives directly on the check. Voiding the check frees the credit.
            const skipPool = getDbPool();
            await skipPool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'skipped',
                      error = 'no $0 apply ReceivePayment doc exists in QB (zero-amount credit apply) — check void alone frees the credit',
                      updated_at = NOW()
                WHERE id = $1`,
              [row.id]
            );
            await skipPool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'pending', updated_at = NOW()
                WHERE depends_on = $1 AND step = 'void_check' AND status = 'waiting'`,
              [row.id]
            );
            logger.info(
              `${LOG_PREFIX} ✅ refund_apply_del ${row.id}: no $0 apply doc in QB — skipped, void_check woken`
            );
            break;
          }
          applyTxnId = linkedRp.txnId;
          const persistPool = getDbPool();
          await persistPool.query(
            `UPDATE qb_order_pipeline SET qb_txn_id = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, applyTxnId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ refund_apply_del ${row.id}: resolved $0 apply TxnID=${applyTxnId} via check LinkedTxns`
          );
        }
        if (!applyTxnId) {
          await failPipelineRow(
            row.id,
            "refund_apply_del: missing qb_txn_id — cannot delete $0 apply"
          );
          break;
        }
        const delResult = await voidPaymentInQb(applyTxnId);
        if (delResult.success && delResult.data?.operationId) {
          const delPool = getDbPool();
          await delPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, delResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ refund_apply_del ${row.id} submitted op=${delResult.data.operationId}`
          );
        } else {
          await failVoidFamilyRow(
            row,
            delResult.error ?? "voidPaymentInQb failed"
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

      case "void_payment": {
        // TxnDel de un ReceivePayment que se creó DESPUÉS de que el usuario ya
        // había voideado el pago (su ADD estaba en vuelo al momento del void).
        // Antes esto no existía: el handler escribía la fila como 'confirmed'
        // sin borrar nada y el pago quedaba vivo en QuickBooks para siempre.
        //
        // Un TxnDel es más seguro de reintentar que un ADD — borrar dos veces
        // devuelve error, nunca duplica — así que va por failVoidFamilyRow
        // (transitorios reintentan con backoff).
        if (await voidBlockedByLiveMutation(row, logger)) break;
        if (!row.qb_txn_id) {
          await failPipelineRow(
            row.id,
            "void_payment: missing qb_txn_id — cannot delete the ReceivePayment"
          );
          break;
        }
        const vpResult = await voidPaymentInQb(row.qb_txn_id);
        if (vpResult.success && vpResult.data?.operationId) {
          const vpPool = getDbPool();
          await vpPool.query(
            `UPDATE qb_order_pipeline
                  SET status = 'submitted',
                      bridge_op_id = $2,
                      submitted_at = NOW(),
                      updated_at = NOW()
                WHERE id = $1`,
            [row.id, vpResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_payment ${row.id} submitted op=${vpResult.data.operationId}`
          );
        } else {
          await failVoidFamilyRow(
            row,
            vpResult.error ?? "voidPaymentInQb failed"
          );
        }
        break;
      }

      // ── Defectuosos de un credit memo ───────────────────────────────────
      // Un credit memo posee UN InventoryAdjustment durante toda su vida. El
      // add lo crea; el mod lo edita; el void lo retira. Nunca hay un segundo
      // documento. Ver lib/quickbooks/damage/sync-damage-adjustment.ts.

      case "cm_damage_adjustment": {
        const pool = getDbPool();
        const payload = row.payload as DamageAdjustmentAddPayload | null;
        if (!payload?.lines?.length) {
          await failPipelineRow(
            row.id,
            "cm_damage_adjustment: payload vacío o sin líneas"
          );
          break;
        }
        const addResult = await postDamageAdjustmentAddToQb(
          row.id,
          payload,
          container,
          logger
        );
        if (addResult.success) {
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, addResult.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ cm_damage_adjustment ${row.id} submitted op=${addResult.operationId}`
          );
        } else {
          await failPipelineRow(row.id, addResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ cm_damage_adjustment ${row.id} failed: ${addResult.error}`
          );
        }
        break;
      }

      case "cm_damage_adjustment_mod": {
        const pool = getDbPool();
        const payload = row.payload as DamageAdjustmentAddPayload | null;
        const adjTxnId = row.qb_txn_id;
        if (!payload?.lines?.length || !adjTxnId) {
          await failPipelineRow(
            row.id,
            "cm_damage_adjustment_mod: falta payload o qb_txn_id del ajuste"
          );
          break;
        }

        // EditSequence y TxnLineIDs se leen de QuickBooks en CADA intento. Un
        // EditSequence cacheado da 3200, y una lista de líneas armada de memoria
        // borra por omisión las que no nombra.
        const snapshot = await fetchDamageAdjustmentSnapshot(adjTxnId, logger);
        if (!snapshot) {
          // QuickBooks no conoce ese TxnID: alguien borró el ajuste a mano. Es
          // estado TERMINAL, no un fallo reintentable — reintentarlo generaría
          // una fila muerta por tick, para siempre. Se suelta el puntero para
          // que el próximo cambio de defectuosos cree un ajuste nuevo.
          await pool.query(
            `UPDATE pos_credit_memo
                SET qb_inventory_adjustment_txn_id = NULL,
                    qb_inventory_adjustment_edit_sequence = NULL
              WHERE id = $1`,
            [payload.credit_memo_id]
          );
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped',
                    error = $2,
                    next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = $1`,
            [
              row.id,
              `el ajuste ${adjTxnId} ya no existe en QuickBooks (borrado a mano) — puntero liberado`,
            ]
          );
          logger.warn(
            `${LOG_PREFIX} ⚠️ cm_damage_adjustment_mod ${row.id}: ajuste ${adjTxnId} ausente en QB → skipped`
          );
          break;
        }

        const modResult = await postDamageAdjustmentModToQb(
          row.id,
          {
            ...payload,
            txn_id: adjTxnId,
            edit_sequence: snapshot.edit_sequence,
            qb_line_ids: snapshot.qb_line_ids,
            qb_line_order: snapshot.qb_line_order,
            current_quantities: snapshot.current_quantities,
          },
          container,
          logger
        );

        if (modResult.success && "noop" in modResult && modResult.noop) {
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'skipped',
                    error = 'sin cambios contra QuickBooks',
                    next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = $1`,
            [row.id]
          );
          break;
        }
        if (modResult.success && "operationId" in modResult) {
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2,
                    qb_edit_sequence = $3,
                    submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, modResult.operationId, snapshot.edit_sequence]
          );
          logger.info(
            `${LOG_PREFIX} ✅ cm_damage_adjustment_mod ${row.id} submitted op=${modResult.operationId}`
          );
        } else if (!modResult.success) {
          await failPipelineRow(row.id, modResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ cm_damage_adjustment_mod ${row.id} failed: ${modResult.error}`
          );
        }
        break;
      }

      case "void_cm_damage_adjustment": {
        if (await voidBlockedByLiveMutation(row, logger)) break;
        if (!row.qb_txn_id) {
          await failPipelineRow(
            row.id,
            "void_cm_damage_adjustment: missing qb_txn_id"
          );
          break;
        }
        const vdResult = await voidInventoryAdjustmentInQb(
          row.id,
          row.qb_txn_id
        );
        if (vdResult.success) {
          const pool = getDbPool();
          await pool.query(
            `UPDATE qb_order_pipeline
                SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [row.id, vdResult.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ void_cm_damage_adjustment ${row.id} submitted op=${vdResult.operationId}`
          );
        } else {
          await failVoidFamilyRow(row, vdResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ void_cm_damage_adjustment ${row.id} failed: ${vdResult.error}`
          );
        }
        break;
      }

      case "void_inventory_adjustment": {
        if (await voidBlockedByLiveMutation(row, logger)) break;
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
          await failVoidFamilyRow(row, viaResult.error);
          logger.warn(
            `${LOG_PREFIX} ❌ void_inventory_adjustment ${row.id} failed: ${viaResult.error}`
          );
        }
        break;
      }

      case "commission_check": {
        const { dispatchCommissionCheck } =
          require("../handlers/handle-commission-settlement") as typeof import("../handlers/handle-commission-settlement");
        await dispatchCommissionCheck(
          {
            id: row.id,
            reference_id: row.reference_id ?? null,
            step: row.step,
            payload: row.payload ?? null,
            retry_count: row.retry_count ?? 0,
          },
          logger
        );
        break;
      }

      case "commission_payment": {
        const { dispatchCommissionPayment } =
          require("../handlers/handle-commission-settlement") as typeof import("../handlers/handle-commission-settlement");
        await dispatchCommissionPayment(
          {
            id: row.id,
            reference_id: row.reference_id ?? null,
            step: row.step,
            payload: row.payload ?? null,
            retry_count: row.retry_count ?? 0,
          },
          logger
        );
        break;
      }

      case "vendor_bill_payment_check": {
        const txnId =
          row.qb_txn_id ??
          (typeof row.payload?.txn_id === "string" ? row.payload.txn_id : null);
        if (!txnId) {
          await failPipelineRow(
            row.id,
            "vendor_bill_payment_check: missing QB TxnID"
          );
          break;
        }
        const result = await bridgeFetch("POST", "/api/bills/query", {
          txn_id: txnId,
          max_returned: 5,
        });
        if (!result?.operationId) {
          await failPipelineRow(
            row.id,
            result?.error ?? "BillQuery returned no operationId"
          );
          break;
        }
        const pool = getDbPool();
        await pool.query(
          `UPDATE qb_order_pipeline
              SET status = 'submitted',
                  bridge_op_id = $2,
                  submitted_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, result.operationId]
        );
        logger.info(
          `${LOG_PREFIX} ✅ vendor_bill_payment_check ${row.id} submitted op=${result.operationId}`
        );
        break;
      }

      case "vendor_bill_mod": {
        const txnId =
          row.qb_txn_id ??
          (typeof row.payload?.txn_id === "string" ? row.payload.txn_id : null);
        if (!txnId || !row.payload) {
          throw new Error("vendor_bill_mod: missing QB TxnID or payload");
        }
        const refreshedPayload = await refreshVendorBillModSnapshot(
          row.payload,
          logger
        );
        const result = await bridgeFetch(
          "PUT",
          `/api/bills/${encodeURIComponent(txnId)}`,
          refreshedPayload
        );
        if (!result?.operationId) {
          throw new Error(
            result?.error ?? "BillMod returned no operationId"
          );
        }
        const pool = getDbPool();
        await pool.query(
          `UPDATE qb_order_pipeline
              SET status = 'submitted', bridge_op_id = $2,
                  payload = $3::jsonb,
                  submitted_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [row.id, result.operationId, JSON.stringify(refreshedPayload)]
        );
        await pool.query(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'submitted', qb_operation_id = $2,
                  payload = $3::jsonb, edit_sequence = $4,
                  last_error = NULL, next_retry_at = NULL, updated_at = NOW()
            WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
          [
            row.reference_id,
            result.operationId,
            JSON.stringify(refreshedPayload),
            refreshedPayload.edit_sequence,
          ]
        );
        logger.info(
          `${LOG_PREFIX} ✅ vendor_bill_mod ${row.id} submitted op=${result.operationId}`
        );
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
    if (
      row.step === "vendor_bill_mod" ||
      PURCHASE_OPERATION_STEPS.includes(
        row.step as (typeof PURCHASE_OPERATION_STEPS)[number]
      )
    ) {
      await failOrRetryPipelineRow(
        row.id,
        err.message || `${row.step} dispatch failed`,
        row.retry_count ?? 0
      );
    } else {
      await failPipelineRow(row.id, err.message || "resubmitByStep failed");
    }
    if (row.step === "vendor_bill_mod" && row.reference_id) {
      const pool = getDbPool();
      await pool.query(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'error', qb_operation_id = NULL,
                last_error = $2, updated_at = NOW()
          WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
        [row.reference_id, err.message || "BillMod dispatch failed"]
      );
    }
    if (
      PURCHASE_OPERATION_STEPS.includes(
        row.step as (typeof PURCHASE_OPERATION_STEPS)[number]
      )
    ) {
      await mirrorPurchaseOperationFailure(
        row,
        err.message || `${row.step} dispatch failed`
      ).catch(() => undefined);
    }
  }
}
