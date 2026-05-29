import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { Client } from "pg";

import { pollOperationResult } from "../../../../../lib/quickbooks/client/core";
import { parseSalesRepInitials } from "../../../../../lib/quickbooks/parse-sales-rep";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  // POST /admin/quickbooks/pipeline?action=retry&id=<uuid>
  //   Re-submits a failed operation immediately.
  // POST /admin/quickbooks/pipeline?action=mark-fixed&id=<uuid>
  //   Marks a failed row as 'fixed' (acknowledged — user resolved manually
  //   in QuickBooks Desktop). No bridge call, no retry; just updates status.
  const rowId = req.query.id as string | undefined;
  const action = req.query.action as string | undefined;

  if (!rowId || (action !== "retry" && action !== "mark-fixed")) {
    res.status(400).json({
      error: "Requires ?action=retry|mark-fixed&id=<uuid>",
    });
    return;
  }

  const logger0 = req.scope.resolve(ContainerRegistrationKeys.LOGGER);

  if (action === "mark-fixed") {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const { rows } = await client.query(
        `UPDATE qb_order_pipeline
            SET status = 'fixed', updated_at = NOW()
          WHERE id = $1 AND status IN ('failed', 'manual')
          RETURNING id, step, order_id, medusa_ref_number, qb_ref_number`,
        [rowId]
      );
      if (!rows.length) {
        res.status(404).json({
          error: "Row not found or not in 'failed'/'manual' status",
        });
        return;
      }
      const row = rows[0];
      logger0.info(
        `[QB Pipeline Mark-Fixed] ${row.step} ${row.medusa_ref_number ?? row.order_id} → fixed`
      );
      res.status(200).json({
        success: true,
        id: row.id,
        message: `Marked as fixed: ${row.medusa_ref_number ?? row.qb_ref_number ?? row.order_id} (${row.step})`,
      });
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger0.error(`[QB Pipeline Mark-Fixed] failed: ${msg}`);
      res.status(500).json({ error: msg });
      return;
    } finally {
      await client.end();
    }
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const LOG_PREFIX = "[QB Pipeline Retry]";

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // 1. Atomically claim the row — only 'failed' and 'waiting' are retryable.
    //    'pending' is excluded because it means a handler is already in-flight;
    //    retrying it would send a second request to QB and create duplicates.
    //    Stuck-pending rows will auto-timeout to 'failed' via the GET auto-timeout logic.
    //
    //    For steps that support MOD (estimate, invoice, sales_order), PRESERVE qb_txn_id
    //    and qb_ref_number so the retry hits the MOD path (updates existing QB doc)
    //    instead of CREATE (which would produce duplicate QB documents).
    const { rows } = await client.query(
      `UPDATE qb_order_pipeline
             SET status       = 'pending',
                 updated_at   = NOW(),
                 error        = NULL,
                 failed_at    = NULL,
                 confirmed_at = NULL,
                 submitted_at = NULL,
                 bridge_op_id = NULL,
                 qb_txn_id    = CASE
                   WHEN step IN ('estimate', 'invoice', 'sales_order') THEN qb_txn_id
                   ELSE NULL
                 END,
                 qb_ref_number = CASE
                   WHEN step IN ('estimate', 'invoice', 'sales_order') THEN qb_ref_number
                   ELSE NULL
                 END,
                 retry_count  = retry_count + 1
             WHERE id = $1 AND status IN ('failed', 'waiting')
             RETURNING id, step, order_id, reference_id, reference_type, retry_count, bridge_op_id, qb_txn_id, qb_ref_number`,
      [rowId]
    );
    if (!rows.length) {
      res.status(404).json({
        error:
          "Row not found or not retryable (must be 'failed' or 'waiting'; 'pending' rows are actively processing — wait for timeout)",
      });
      return;
    }
    const row = rows[0];

    // 2a. If we already have a bridge_op_id, just re-poll — do NOT resubmit to avoid duplicates
    if (row.bridge_op_id) {
      await client.end();
      logger.info(
        `${LOG_PREFIX} Found existing bridge_op_id=${row.bridge_op_id} — polling instead of resubmitting`
      );
      (async () => {
        try {
          const pollResult = await pollOperationResult(
            row.bridge_op_id,
            (m: string) => logger.info(m)
          );
          if (pollResult?.txnId) {
            await writePipelineRow({
              orderId: row.order_id,
              step: row.step,
              status: "confirmed",
              bridgeOpId: row.bridge_op_id,
              qbTxnId: pollResult.txnId,
              qbRefNumber: pollResult.refNumber ?? null,
            });
            logger.info(
              `${LOG_PREFIX} ✅ Re-poll confirmed TxnID=${pollResult.txnId}`
            );
          } else {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Re-poll did not return txnId — bridge op may still be pending`
            );
          }
        } catch (pollErr: unknown) {
          const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
          logger.error(`${LOG_PREFIX} Re-poll failed: ${msg}`);
        }
      })();

      res.json({
        message: "Re-polling existing bridge operation",
        bridge_op_id: row.bridge_op_id,
      });
      return;
    }

    // 3. Reset qb_sync_status on the entity so guards allow re-sync
    if (row.order_id) {
      try {
        const orderModule = req.scope.resolve(Modules.ORDER);
        const order = await orderModule.retrieveOrder(row.order_id);
        const meta = ((order as unknown) as Record<string, unknown>).metadata as Record<string, unknown> || {};
        const currentStatus = meta.qb_sync_status;
        if (
          currentStatus &&
          currentStatus !== "error" &&
          currentStatus !== "voided"
        ) {
          await orderModule.updateOrders(row.order_id, {
            metadata: { ...meta, qb_sync_status: "error" },
          });
        }
      } catch (metaErr: unknown) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        logger.warn(`${LOG_PREFIX} Could not reset qb_sync_status: ${msg}`);
      }
    }

    // 3b. For payment/apply_payment steps: also reset the customer_payment entity's qb_sync_status
    if (
      (row.step === "payment" || row.step === "apply_payment") &&
      row.reference_id
    ) {
      try {
        const financeService = req.scope.resolve("finance");
        const payment = await financeService.retrieveCustomerPayment(
          row.reference_id
        );
        const pmeta = (payment as Record<string, unknown>).metadata as Record<string, unknown> || {};
        if (pmeta.qb_sync_status && pmeta.qb_sync_status !== "error") {
          await financeService.updateCustomerPayments({
            id: row.reference_id,
            metadata: { ...pmeta, qb_sync_status: "error" },
          });
          logger.info(
            `${LOG_PREFIX} Reset payment qb_sync_status for ${row.reference_id}`
          );
        }
      } catch (pmErr: unknown) {
        const msg = pmErr instanceof Error ? pmErr.message : String(pmErr);
        logger.warn(`${LOG_PREFIX} Could not reset payment qb_sync_status: ${msg}`);
      }
    }

    // 4. Fire the appropriate handler in the background
    const retryCount = (row.retry_count ?? 0) + 1;
    logger.info(
      `${LOG_PREFIX} Retrying step=${row.step} order=${row.order_id} retry#${retryCount}`
    );
    (async () => {
      try {
        // 1.5.7: orderModule no longer needed in this block — retry cases
        // now enqueue pipeline rows instead of calling handlers directly.
        const customerModule = req.scope.resolve(Modules.CUSTOMER);

        switch (row.step) {
          case "estimate": {
            // 1.5.4: pipeline-only retry — enqueue 'pending' instead of
            // calling handlers directly. Consolidator's pending-dispatch pass
            // picks it up and runs MOD-first → CREATE-fallback via case "estimate".
            const {
              writePipelineRow: enqueueEst,
            } = require("../../../../../lib/quickbooks/qb-pipeline");
            await enqueueEst({
              orderId: row.order_id,
              step: "estimate",
              status: "pending",
            });
            logger.info(
              `[qb-pipeline-retry] 📥 Re-enqueued estimate for ${row.order_id}`
            );
            break;
          }
          case "sales_order": {
            // 1.5.5: pipeline-only retry — enqueue 'pending' instead of
            // calling handlers directly. Consolidator's pending-dispatch
            // pass picks it up and runs MOD-first → CREATE-fallback.
            const {
              writePipelineRow: enqueueSoRetry,
            } = require("../../../../../lib/quickbooks/qb-pipeline");
            await enqueueSoRetry({
              orderId: row.order_id,
              step: "sales_order",
              status: "pending",
            });
            logger.info(
              `[qb-pipeline-retry] 📥 Re-enqueued sales_order for ${row.order_id}`
            );
            break;
          }
          case "invoice": {
            // 1.5.7: pipeline-only retry — re-enqueue 'pending' for consolidator.
            const {
              writePipelineRow: enqueueInvRetry,
            } = require("../../../../../lib/quickbooks/qb-pipeline");
            await enqueueInvRetry({
              orderId: row.order_id,
              referenceId: row.reference_id,
              referenceType: "invoice",
              step: "invoice",
              status: "pending",
              payload: {
                invoice_id: row.reference_id,
                fulfillment_id: row.reference_id,
              },
            });
            logger.info(
              `[qb-pipeline-retry] 📥 Re-enqueued invoice for ${row.order_id}`
            );
            break;
          }
          case "sales_receipt": {
            // 1.5.6: pipeline-only retry — re-enqueue 'pending' for consolidator.
            const {
              writePipelineRow: enqueueSrRetry,
            } = require("../../../../../lib/quickbooks/qb-pipeline");
            await enqueueSrRetry({
              orderId: row.order_id,
              referenceId: row.reference_id,
              referenceType: "invoice",
              step: "sales_receipt",
              status: "pending",
              payload: {
                invoice_id: row.reference_id,
                fulfillment_id: row.reference_id,
              },
            });
            logger.info(
              `[qb-pipeline-retry] 📥 Re-enqueued sales_receipt for ${row.order_id}`
            );
            break;
          }
          case "payment": {
            const {
              handlePosPaymentCreated,
            } = require("../../../../../lib/quickbooks/handlers/handle-pos-payment-created");
            await handlePosPaymentCreated({
              event: {
                name: "pos.payment.created",
                data: { id: row.reference_id ?? row.order_id },
              },
              container: req.scope as unknown,
              pluginOptions: {},
            });
            break;
          }
          case "apply_payment": {
            const {
              handlePosPaymentApplied,
            } = require("../../../../../lib/quickbooks/handlers/handle-pos-payment-applied");
            // Fetch the application to get invoice_id and amount_applied
            const applyClient = new Client({
              connectionString: process.env.DATABASE_URL,
            });
            await applyClient.connect();
            // row.reference_id may be a payment_application id (papp_, current
            // keying) OR a customer_payment id (cpay_, legacy) — match either.
            const { rows: appRows } = await applyClient.query(
              `SELECT id, payment_id, invoice_id, order_id, amount_applied
                 FROM payment_application
                WHERE (id = $1 OR payment_id = $1) AND voided_at IS NULL LIMIT 1`,
              [row.reference_id]
            );
            await applyClient.end();
            const appRow = appRows[0];
            await handlePosPaymentApplied({
              event: {
                name: "pos.payment.applied",
                data: {
                  payment_id: appRow?.payment_id ?? row.reference_id,
                  invoice_id: appRow?.invoice_id ?? null,
                  order_id: appRow?.order_id ?? row.order_id,
                  amount_applied: appRow?.amount_applied ?? 0,
                  // Pass the canonical papp_ key so the handler never falls back
                  // to the customer_payment key and creates a duplicate row.
                  application_id: appRow?.id ?? undefined,
                },
              },
              container: req.scope as unknown,
            });
            break;
          }
          case "void_sales_order": {
            // qb_txn_id may be NULL when the row was created by the chaining mechanism
            // (order canceled while estimate was still in-flight). Look it up from the
            // confirmed estimate/sales_order row for the same order.
            let soTxnId: string | null = row.qb_txn_id ?? null;
            if (!soTxnId && row.order_id) {
              const voidPool =
                require("../../../../../api/utils/db-pool").getDbPool();
              const { rows: soRows } = await voidPool.query(
                `SELECT qb_txn_id FROM qb_order_pipeline
                 WHERE order_id = $1
                   AND step IN ('estimate', 'sales_order')
                   AND status = 'confirmed'
                   AND qb_txn_id IS NOT NULL
                 ORDER BY confirmed_at DESC LIMIT 1`,
                [row.order_id]
              );
              soTxnId = soRows[0]?.qb_txn_id ?? null;
              if (soTxnId) {
                await voidPool.query(
                  `UPDATE qb_order_pipeline SET qb_txn_id = $2, updated_at = NOW() WHERE id = $1`,
                  [row.id, soTxnId]
                );
              }
            }
            if (!soTxnId) {
              logger.warn(
                `${LOG_PREFIX} void_sales_order: no QB TxnID for order ${row.order_id} — marking failed`
              );
              const voidPool =
                require("../../../../../api/utils/db-pool").getDbPool();
              await voidPool.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [
                  row.id,
                  "Cannot retry: no confirmed estimate/sales_order TxnID found",
                ]
              );
              break;
            }
            const {
              closeSalesOrderInQb,
            } = require("../../../../../lib/quickbooks/qb-bridge-client");
            const closeResult = await closeSalesOrderInQb(
              soTxnId,
              (m: string) => logger.info(m)
            );
            const voidPool2 =
              require("../../../../../api/utils/db-pool").getDbPool();
            if (!closeResult.success) {
              logger.error(
                `${LOG_PREFIX} void_sales_order failed: ${closeResult.error}`
              );
              await voidPool2.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW(), qb_txn_id = $3 WHERE id = $1`,
                [row.id, closeResult.error ?? "SO close failed", soTxnId]
              );
            } else {
              const soOpId = closeResult.data?.operationId ?? null;
              logger.info(
                `${LOG_PREFIX} void_sales_order queued (op: ${soOpId})`
              );
              await voidPool2.query(
                `UPDATE qb_order_pipeline SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), qb_txn_id = $3, updated_at = NOW() WHERE id = $1`,
                [row.id, soOpId, soTxnId]
              );
            }
            break;
          }
          case "void_invoice":
          case "void_sales_receipt": {
            if (!row.qb_txn_id) {
              logger.warn(
                `${LOG_PREFIX} ${row.step}: no QB TxnID — marking failed`
              );
              const voidPool =
                require("../../../../../api/utils/db-pool").getDbPool();
              await voidPool.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, "Cannot retry: missing qb_txn_id"]
              );
              break;
            }
            const {
              voidInvoiceInQb,
              voidSalesReceiptInQb,
            } = require("../../../../../lib/quickbooks/qb-bridge-client");
            const voidResult =
              row.step === "void_sales_receipt"
                ? await voidSalesReceiptInQb(row.qb_txn_id, (m: string) =>
                    logger.info(m)
                  )
                : await voidInvoiceInQb(row.qb_txn_id, (m: string) =>
                    logger.info(m)
                  );
            const voidPool2 =
              require("../../../../../api/utils/db-pool").getDbPool();
            if (!voidResult.success) {
              logger.error(
                `${LOG_PREFIX} ${row.step} failed: ${voidResult.error}`
              );
              await voidPool2.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, voidResult.error ?? `${row.step} failed`]
              );
            } else {
              const voidOpId = voidResult.data?.operationId ?? null;
              logger.info(
                `${LOG_PREFIX} ${row.step} queued (op: ${voidOpId})`
              );
              await voidPool2.query(
                `UPDATE qb_order_pipeline SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, voidOpId]
              );
            }
            break;
          }
          case "void_check": {
            if (!row.qb_txn_id) {
              logger.warn(
                `${LOG_PREFIX} void_check: no QB TxnID — marking failed`
              );
              const vcPool =
                require("../../../../../api/utils/db-pool").getDbPool();
              await vcPool.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, "Cannot retry: missing qb_txn_id"]
              );
              break;
            }
            const {
              voidCheckInQb,
            } = require("../../../../../lib/quickbooks/client/checks");
            const checkResult = await voidCheckInQb(row.qb_txn_id);
            const vcPool2 =
              require("../../../../../api/utils/db-pool").getDbPool();
            if (!checkResult.success) {
              logger.error(
                `${LOG_PREFIX} void_check failed: ${checkResult.error}`
              );
              await vcPool2.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, checkResult.error ?? "void_check failed"]
              );
            } else {
              const opId = checkResult.data?.operationId ?? null;
              logger.info(`${LOG_PREFIX} void_check queued (op: ${opId})`);
              await vcPool2.query(
                `UPDATE qb_order_pipeline SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, opId]
              );
            }
            break;
          }
          case "write_check": {
            // write_check retries require user to re-select the bank account.
            // Reset CustomerPayment.qb to null so it reappears in /accounting as "Pending QB".
            if (row.reference_id) {
              try {
                const retryPool =
                  require("../../../../../api/utils/db-pool").getDbPool();
                await retryPool.query(
                  `UPDATE customer_payment SET qb = NULL WHERE id = $1`,
                  [row.reference_id]
                );
                await retryPool.query(
                  `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), confirmed_at = NULL, updated_at = NOW() WHERE id = $1`,
                  [
                    row.id,
                    "Retry: re-process from Accounting page — bank account selection required",
                  ]
                );
                logger.info(
                  `${LOG_PREFIX} write_check reset → CustomerPayment ${row.reference_id} qb=null, ready for re-process from Accounting`
                );
              } catch (wcRetryErr: unknown) {
                const msg = wcRetryErr instanceof Error ? wcRetryErr.message : String(wcRetryErr);
                logger.warn(
                  `${LOG_PREFIX} Could not reset write_check: ${msg}`
                );
              }
            }
            break;
          }
          case "credit_memo": {
            if (!row.reference_id) {
              logger.warn(`${LOG_PREFIX} credit_memo retry: no reference_id`);
              break;
            }
            const cmPool = require("../../../../../api/utils/db-pool").getDbPool();
            const { rows: cmRows } = await cmPool.query(
              `SELECT cm.id, cm.credit_memo_number, cm.customer_id, cm.invoice_id,
                      cm.completed_at, cm.sales_rep,
                      cm.discount, cm.shipping, cm.shipping_option_name,
                      -- Tax-exempt logic:
                      --   invoice_id set → from parent pos_invoice (tax=0 & subtotal>0 => exempt)
                      --   else (quick credit) → from customer metadata
                      CASE
                        WHEN cm.invoice_id IS NOT NULL
                          THEN (inv.tax = 0 AND inv.subtotal > 0)
                        ELSE (
                          LOWER(c.metadata->>'is_tax_exempt') IN ('yes','true')
                        )
                      END AS is_tax_exempt,
                      COALESCE(
                        json_agg(
                          json_build_object(
                            'sku', i.sku,
                            'title', i.title,
                            'description', i.description,
                            'quantity', i.quantity,
                            'unit_price', i.unit_price,
                            'variant_id', i.variant_id,
                            'quickbooks_id', pv.metadata->>'quickbooks_id',
                            'is_service', (pv.metadata->>'quickbooks_is_service' = 'true'
                                           OR pv.metadata->>'quickbooks_no_site' = 'true'
                                           OR p.metadata->>'quickbooks_is_service' = 'true'
                                           OR p.metadata->>'quickbooks_no_site' = 'true'
                                           OR pv.metadata->>'qb_item_type' IN
                                               ('Service','NonInventory','NonInventoryPart',
                                                'OtherCharge','Discount')
                                           OR p.metadata->>'qb_item_type' IN
                                               ('Service','NonInventory','NonInventoryPart',
                                                'OtherCharge','Discount'))
                          )
                        ) FILTER (WHERE i.id IS NOT NULL),
                        '[]'
                      ) AS items
               FROM pos_credit_memo cm
               LEFT JOIN pos_credit_memo_item i
                 ON i.credit_memo_id = cm.id AND i.deleted_at IS NULL AND i.quantity > 0
               LEFT JOIN product_variant pv ON pv.id = i.variant_id
               LEFT JOIN product p ON p.id = pv.product_id
               LEFT JOIN pos_invoice inv ON inv.id = cm.invoice_id
               LEFT JOIN customer c ON c.id = cm.customer_id
               WHERE cm.id = $1
               GROUP BY cm.id, inv.tax, inv.subtotal, c.metadata`,
              [row.reference_id]
            );
            const cm = cmRows[0];
            if (!cm) {
              logger.warn(
                `${LOG_PREFIX} credit_memo retry: CM not found ${row.reference_id}`
              );
              break;
            }
            let cmCustomer: unknown;
            try {
              cmCustomer = await customerModule.retrieveCustomer(
                cm.customer_id
              );
            } catch {
              await cmPool.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, `Customer not found: ${cm.customer_id}`]
              );
              break;
            }
            // 1.5.8: pipeline-only retry — build payload, set row to
            // 'pending' with full data. Consolidator's case 'credit_memo'
            // resolves customer + submits to bridge next tick.
            const {
              ensureCustomerInQb,
              getBusinessDateString,
            } = require("../../../../../lib/quickbooks/order-flow-core");
            const custResult = await ensureCustomerInQb(
              cmCustomer,
              customerModule,
              (m: string) => logger.info(m)
            );
            if (!custResult.success || !custResult.qbCustomerId) {
              await cmPool.query(
                `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [row.id, `Customer not in QB: ${custResult.error ?? "unknown"}`]
              );
              break;
            }
            const qbItems = (cm.items ?? []).map((item: Record<string, unknown>) => {
              const unitPriceDollars = (Number(item.unit_price) || 0) / 100;
              const isService = !item.variant_id || item.is_service === true;
              return {
                ...(item.quickbooks_id
                  ? { productId: item.quickbooks_id }
                  : {}),
                productName: item.sku || item.title,
                quantity: item.quantity,
                price: unitPriceDollars,
                amount: Number((unitPriceDollars * Number(item.quantity)).toFixed(2)),
                desc: item.description || item.title,
                ...(isService ? { noSite: true } : {}),
                ...(isService ? { taxable: false } : {}),
              };
            });
            const cmSalesRepRef = parseSalesRepInitials(cm.sales_rep);
            const cmRetryPayload = {
              customerId: custResult.qbCustomerId,
              date: getBusinessDateString(
                cm.completed_at ?? cm.created_at ?? null
              ),
              memo: `POS Return ${cm.credit_memo_number || ""}`.trim(),
              items: qbItems,
              ...(cm.is_tax_exempt === true ? { taxExempt: true } : {}),
              ...(cmSalesRepRef ? { salesRepRef: cmSalesRepRef } : {}),
            };
            await cmPool.query(
              `UPDATE qb_order_pipeline
               SET status = 'pending', payload = $2::jsonb, error = NULL,
                   failed_at = NULL, updated_at = NOW()
               WHERE id = $1`,
              [row.id, JSON.stringify(cmRetryPayload)]
            );
            logger.info(
              `${LOG_PREFIX} 📥 credit_memo retry: row reset to pending, consolidator will submit`
            );
            break;
          }
          default:
            logger.warn(`${LOG_PREFIX} No retry handler for step=${row.step}`);
        }
      } catch (handlerErr: unknown) {
        const msg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
        logger.error(`${LOG_PREFIX} Background retry failed: ${msg}`);
      }
    })();

    res.json({
      success: true,
      message: `Retrying ${row.step} — re-submitted to bridge`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${LOG_PREFIX} Error: ${msg}`);
    res.status(500).json({ error: "Failed to retry" });
  } finally {
    await client.end();
  }
}
