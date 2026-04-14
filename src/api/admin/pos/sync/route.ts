import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { handleFulfillmentCreated } from "../../../../lib/quickbooks/handlers/handle-fulfillment-created";
import { handleOrderPlaced } from "../../../../lib/quickbooks/handlers/handle-order-placed";
import { handlePosPaymentApplied } from "../../../../lib/quickbooks/handlers/handle-pos-payment-applied";
import { handlePosPaymentCreated } from "../../../../lib/quickbooks/handlers/handle-pos-payment-created";
import { handleSalesReceiptCreated } from "../../../../lib/quickbooks/handlers/handle-sales-receipt-created";
import { parseSalesRepInitials } from "../../../../lib/quickbooks/parse-sales-rep";
import {
  getEstimateTxnId,
  getSoTxnId,
} from "../../../../lib/quickbooks/qb-metadata-types";
import { withQbSerialized } from "../../../../lib/quickbooks/qb-serializer";
import { FINANCE_MODULE } from "../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../modules/invoices";
import { handleDraftOrderCreated } from "../../../../subscribers/qb-draft-order-subscriber";

const LOG_PREFIX = "[POST /admin/pos/sync]";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const {
    type,
    id,
    action = "sync",
  } = req.body as { type?: string; id?: string; action?: "sync" | "void" };

  if (!type || !id) {
    return res.status(400).json({ error: "Missing type or id" });
  }

  logger.info(
    `${LOG_PREFIX} 🔥 Manual QB Action Executed: type=${type}, id=${id}, action=${action}`
  );

  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    const orderModule = req.scope.resolve(Modules.ORDER);
    const customerModule = req.scope.resolve(Modules.CUSTOMER);

    switch (type) {
      case "estimate": {
        // Fetch the draft order
        const {
          data: [order],
        } = await query.graph({
          entity: "order",
          fields: ["metadata"],
          filters: { id },
        });

        if (!order)
          return res.status(404).json({ error: "Estimate not found" });
        if (action === "void") {
          if (!getEstimateTxnId(order.metadata || {})) {
            return res
              .status(400)
              .json({ error: "Cannot close: Estimate is not in QuickBooks." });
          }
          const pipelineStep = "close_estimate";
          const estimateMedusaRef =
            (order.metadata as any)?.document_number ?? null;
          try {
            await orderModule.updateOrders(id, {
              metadata: {
                ...(order.metadata || {}),
                qb_sync_status: "voiding",
              },
            });
            const {
              writePipelineRow,
            } = require("../../../../lib/quickbooks/qb-pipeline");
            await writePipelineRow({
              orderId: id,
              step: pipelineStep,
              status: "pending",
              qbTxnId: getEstimateTxnId(order.metadata || {}),
              medusaRefNumber: estimateMedusaRef,
            });
          } catch (e) {}
          // QuickBooks doesn't natively support "VoidEstimate", but we can mark it inactive/sync status voided.
          const {
            closeEstimateInQb,
          } = require("../../../../lib/quickbooks/qb-bridge-client");
          if (closeEstimateInQb) {
            const qbTxnId = getEstimateTxnId(order.metadata || {});
            closeEstimateInQb(qbTxnId, (m: string) => logger.info(m)).then(
              async (res: any) => {
                try {
                  const {
                    writePipelineRow,
                  } = require("../../../../lib/quickbooks/qb-pipeline");
                  if (res?.success) {
                    await writePipelineRow({
                      orderId: id,
                      step: pipelineStep,
                      status: "submitted",
                      bridgeOpId: res.data?.operationId,
                      qbTxnId,
                      medusaRefNumber: estimateMedusaRef,
                    });
                  } else {
                    await writePipelineRow({
                      orderId: id,
                      step: pipelineStep,
                      status: "failed",
                      error: res?.error,
                      qbTxnId,
                      medusaRefNumber: estimateMedusaRef,
                    });
                  }
                } catch (e) {}
              }
            );
          }
          try {
            const refreshed = await orderModule.retrieveOrder(id);
            await orderModule.updateOrders(id, {
              metadata: {
                ...(refreshed.metadata || {}),
                qb_sync_status: "voided",
              },
            });
          } catch (e) {}
          return res.json({
            success: true,
            message: "Estimate close logic executed",
          });
        }

        // Serialized: CREATE and EDIT share the same lock so rapid saves
        // don't race (e.g. CREATE followed by EDIT before CREATE confirms).
        // Inside the lock we re-read metadata to pick up any txnId the
        // previous operation may have written.
        withQbSerialized(
          `estimate:${id}`,
          { orderId: id, steps: ["estimate"] },
          async () => {
            try {
              // Re-read metadata inside the lock — a prior queued CREATE
              // may have written the qbTxnId since we last checked.
              const {
                data: [freshOrder],
              } = await query.graph({
                entity: "order",
                fields: [
                  "id",
                  "metadata",
                  "tax_total",
                  "subtotal",
                  "discount_total",
                  "items.*",
                  "items.variant.*",
                  "items.variant.metadata",
                ],
                filters: { id },
              });
              if (!freshOrder) return;

              const freshTxnId = getEstimateTxnId(freshOrder.metadata || {});

              if (freshTxnId) {
                // ── EDIT path ──
                const {
                  buildQbItems,
                  buildQbOrderDiscountLines,
                } = require("../../../../lib/quickbooks/order-flow-core");
                const {
                  updateEstimateInQb,
                } = require("../../../../lib/quickbooks/client/estimates");
                const {
                  cacheEditSequence,
                } = require("../../../../lib/quickbooks/qb-pipeline");

                const activeItems = (freshOrder.items || [])
                  .filter((item: any) => (item.quantity ?? 0) > 0)
                  .map((item: any) => ({
                    ...item,
                    unit_price: Number(item.unit_price || 0),
                    subtotal: undefined,
                  }));

                const qbItems = buildQbItems(activeItems, freshOrder.metadata);

                const discountTotal = Number(freshOrder.discount_total || 0);
                if (discountTotal > 0) {
                  const subtotal = Number(freshOrder.subtotal || 0);
                  const pct =
                    subtotal > 0 ? (discountTotal / subtotal) * 100 : null;
                  buildQbOrderDiscountLines(discountTotal, pct).forEach(
                    (l: any) => qbItems.push(l)
                  );
                }

                const hasTax = freshOrder.tax_total && freshOrder.tax_total > 0;
                const salesRep = parseSalesRepInitials(
                  freshOrder.metadata?.sales_rep
                );

                logger.info(
                  `${LOG_PREFIX} Estimate already exists (${freshTxnId}) — running EstimateMod with ${qbItems.length} items`
                );

                const modResult = await updateEstimateInQb({
                  txnId: freshTxnId,
                  items: qbItems,
                  ...(hasTax ? {} : { taxExempt: true }),
                  ...(salesRep ? { salesRep } : {}),
                });

                if (!modResult.success) {
                  logger.error(
                    `${LOG_PREFIX} ❌ Estimate Mod failed: ${modResult.error}`
                  );
                  return;
                }

                if (modResult.data?.operationId) {
                  const {
                    pollOperationResult,
                  } = require("../../../../lib/quickbooks/client/core");
                  const pollResult = await pollOperationResult(
                    modResult.data.operationId
                  );
                  if (pollResult.editSequence) {
                    await cacheEditSequence(
                      "estimate",
                      freshTxnId,
                      pollResult.editSequence
                    );
                    const refreshed = await orderModule.retrieveOrder(id);
                    await orderModule.updateOrders(id, {
                      metadata: {
                        ...(refreshed.metadata || {}),
                        qb_estimate: {
                          ...((refreshed.metadata?.qb_estimate as object) ||
                            {}),
                          edit_sequence: pollResult.editSequence,
                        },
                      },
                    });
                    logger.info(
                      `${LOG_PREFIX} ✅ Estimate Mod confirmed — EditSeq=${pollResult.editSequence}`
                    );
                  }
                }
              } else {
                // ── CREATE path ──
                logger.info(
                  `${LOG_PREFIX} No estimate in QB yet — dispatching CREATE`
                );
                await handleDraftOrderCreated({ id }, req.scope, logger, true);
              }
            } catch (bgErr: any) {
              logger.error(
                `${LOG_PREFIX} Background Estimate sync error: ${bgErr.message}`
              );
            }
          },
          { logger }
        );

        return res.json({ success: true, message: "Estimate sync queued" });
      }

      case "order": {
        const {
          data: [order],
        } = await query.graph({
          entity: "order",
          fields: ["metadata", "items.*", "items.detail.*"],
          filters: { id },
        });

        if (!order) return res.status(404).json({ error: "Order not found" });
        if (action === "void") {
          if (!getSoTxnId(order.metadata || {})) {
            return res
              .status(400)
              .json({ error: "Cannot close: Order is not in QuickBooks." });
          }
          try {
            await orderModule.updateOrders(id, {
              metadata: {
                ...(order.metadata || {}),
                qb_sync_status: "voiding",
              },
            });
          } catch (e) {}
          const {
            handleOrderCanceled,
          } = require("../../../../lib/quickbooks/handlers/handle-order-canceled");
          await handleOrderCanceled({ id }, orderModule, logger);
          // Optimistically set to voided or error depending on if it works
          try {
            const refreshed = await orderModule.retrieveOrder(id);
            await orderModule.updateOrders(id, {
              metadata: {
                ...(refreshed.metadata || {}),
                qb_sync_status: "voided",
              },
            });
          } catch (e) {}
          return res.json({
            success: true,
            message: "Order close logic executed",
          });
        }

        // Safety Lock: Check if fully or partially invoiced (fast-fail before lock).
        if (!getSoTxnId(order.metadata || {})) {
          const { data: invoices } = await query.graph({
            entity: "pos_invoice",
            fields: ["id"],
            filters: { order_id: id },
          });
          if (invoices && invoices.length > 0) {
            return res.status(400).json({
              error:
                "Cannot manual-sync Order: Products are already invoiced. Use Invoice manual sync instead to preserve accounting links.",
            });
          }
        }

        // Serialized: CREATE and EDIT share the same lock.
        withQbSerialized(
          `order:${id}`,
          { orderId: id, steps: ["sales_order"] },
          async () => {
            try {
              // Re-read metadata inside the lock — a prior queued CREATE
              // may have written the soTxnId since we last checked.
              const {
                data: [freshOrder],
              } = await query.graph({
                entity: "order",
                fields: [
                  "id",
                  "metadata",
                  "tax_total",
                  "subtotal",
                  "discount_total",
                  "customer_id",
                  "customer.*",
                  "customer.metadata",
                  "items.*",
                  "items.variant.*",
                  "items.variant.metadata",
                  "shipping_methods.*",
                ],
                filters: { id },
              });
              if (!freshOrder) return;

              const freshSoTxnId = getSoTxnId(freshOrder.metadata || {});

              if (freshSoTxnId) {
                // ── EDIT path ──
                const {
                  buildQbItems,
                  buildShippingQbItem,
                  buildQbOrderDiscountLines,
                } = require("../../../../lib/quickbooks/order-flow-core");
                const {
                  updateSalesOrderInQb,
                } = require("../../../../lib/quickbooks/client/sales-orders");
                const {
                  getQbConfig,
                } = require("../../../../lib/quickbooks/handlers/utils");
                const {
                  cacheEditSequence,
                } = require("../../../../lib/quickbooks/qb-pipeline");
                const {
                  pollOperationResult,
                } = require("../../../../lib/quickbooks/client/core");

                const qbConfig = await getQbConfig();
                const activeItems = (freshOrder.items || [])
                  .filter((item: any) => (item.quantity ?? 0) > 0)
                  .map((item: any) => ({
                    ...item,
                    unit_price: Number(item.unit_price || 0),
                    subtotal: undefined,
                  }));

                const qbItems = buildQbItems(activeItems, freshOrder.metadata);

                const discountTotal = Number(freshOrder.discount_total || 0);
                if (discountTotal > 0) {
                  const subtotal = Number(freshOrder.subtotal || 0);
                  const pct =
                    subtotal > 0 ? (discountTotal / subtotal) * 100 : null;
                  buildQbOrderDiscountLines(discountTotal, pct).forEach(
                    (l: any) => qbItems.push(l)
                  );
                }

                const shippingItem = buildShippingQbItem(
                  freshOrder.shipping_methods || [],
                  qbConfig.shippingItemId
                );
                if (shippingItem) qbItems.push(shippingItem);

                const hasTax = freshOrder.tax_total && freshOrder.tax_total > 0;
                const salesTaxCode = hasTax
                  ? qbConfig.defaultSalesTaxCode
                  : undefined;
                const qbListId =
                  (freshOrder.customer as any)?.metadata?.qb_list_id ||
                  freshOrder.metadata?.qb_list_id;
                const salesRep = parseSalesRepInitials(
                  freshOrder.metadata?.sales_rep
                );

                logger.info(
                  `${LOG_PREFIX} SO already exists (${freshSoTxnId}) — running SalesOrderMod with ${qbItems.length} items`
                );

                const modResult = await updateSalesOrderInQb({
                  txnId: freshSoTxnId,
                  ...(qbListId ? { customerId: qbListId } : {}),
                  items: qbItems,
                  ...(salesTaxCode ? { salesTaxCode } : { taxExempt: true }),
                  ...(salesRep ? { salesRep } : {}),
                });

                if (!modResult.success) {
                  logger.error(
                    `${LOG_PREFIX} ❌ SO Mod failed: ${modResult.error}`
                  );
                  return;
                }

                if (modResult.data?.operationId) {
                  const pollResult = await pollOperationResult(
                    modResult.data.operationId
                  );
                  if (pollResult.editSequence) {
                    await cacheEditSequence(
                      "sales_order",
                      freshSoTxnId,
                      pollResult.editSequence
                    );
                    const refreshed = await orderModule.retrieveOrder(id);
                    await orderModule.updateOrders(id, {
                      metadata: {
                        ...(refreshed.metadata || {}),
                        qb_sales_order: {
                          ...((refreshed.metadata?.qb_sales_order as object) ||
                            {}),
                          edit_sequence: pollResult.editSequence,
                        },
                      },
                    });
                    logger.info(
                      `${LOG_PREFIX} ✅ SO Mod confirmed — EditSeq=${pollResult.editSequence}`
                    );
                  }
                }
              } else {
                // ── CREATE path ──
                logger.info(
                  `${LOG_PREFIX} No SO in QB yet — dispatching CREATE`
                );
                await handleOrderPlaced(
                  { id },
                  orderModule,
                  customerModule,
                  req.scope,
                  logger,
                  true
                );
              }
            } catch (bgErr: any) {
              logger.error(
                `${LOG_PREFIX} Background SO sync error: ${bgErr.message}`
              );
            }
          },
          { logger }
        );

        return res.json({ success: true, message: "Sales Order sync queued" });
      }

      case "invoice": {
        const invoiceService = req.scope.resolve(INVOICE_MODULE);
        const invoice = await invoiceService.retrievePosInvoice(id);
        if (!invoice)
          return res.status(404).json({ error: "Invoice not found" });

        if (action === "void") {
          if (
            !invoice.metadata?.qb_txn_id &&
            !invoice.metadata?.qb_ref_number &&
            !invoice.metadata?.qb_invoice_txn_id &&
            !invoice.metadata?.qb_sales_receipt_txn_id
          ) {
            return res
              .status(400)
              .json({ error: "Cannot void: Invoice is not in QuickBooks." });
          }
          const {
            handleInvoiceVoided,
          } = require("../../../../lib/quickbooks/handlers/handle-invoice-voided");
          await handleInvoiceVoided(
            { order_id: invoice.order_id, invoice_id: id },
            orderModule,
            logger,
            req.scope
          );
          return res.json({
            success: true,
            message: "Invoice void logic executed",
          });
        }

        // Serialized: CREATE and EDIT share the same lock per order.
        withQbSerialized(
          `invoice:${invoice.order_id}`,
          { orderId: invoice.order_id, steps: ["invoice", "sales_receipt"] },
          async () => {
            try {
              // Re-read invoice metadata inside the lock — a prior CREATE
              // may have written the txnId since we entered the queue.
              const freshInvoice = await invoiceService.retrievePosInvoice(id);
              if (!freshInvoice) return;

              const freshTxnId =
                freshInvoice.metadata?.qb_txn_id ||
                freshInvoice.metadata?.qb_ref_number ||
                freshInvoice.metadata?.qb_invoice_txn_id ||
                freshInvoice.metadata?.qb_sales_receipt_txn_id;

              if (freshTxnId) {
                // ── EDIT path ── update salesRep (+ cache EditSequence)
                const isSR = !!(
                  freshInvoice.metadata?.qb_sales_receipt_txn_id ||
                  freshInvoice.metadata?.is_sales_receipt === true ||
                  freshInvoice.metadata?.is_sales_receipt === "true"
                );

                const {
                  data: [parentOrder],
                } = await query.graph({
                  entity: "order",
                  fields: ["metadata"],
                  filters: { id: invoice.order_id },
                });
                const salesRep = parseSalesRepInitials(
                  parentOrder?.metadata?.sales_rep
                );

                if (salesRep) {
                  if (isSR) {
                    const {
                      updateSalesReceiptInQb,
                    } = require("../../../../lib/quickbooks/client/sales-receipts");
                    const modResult = await updateSalesReceiptInQb({
                      txnId: freshTxnId,
                      salesRep,
                    });
                    if (!modResult.success) {
                      logger.error(
                        `${LOG_PREFIX} ❌ Sales Receipt Mod failed: ${modResult.error}`
                      );
                      return;
                    }
                    logger.info(
                      `${LOG_PREFIX} ✅ Sales Receipt ${freshTxnId} salesRep update queued (op: ${modResult.data?.operationId})`
                    );
                  } else {
                    const {
                      updateInvoiceInQb,
                    } = require("../../../../lib/quickbooks/client/invoices");
                    const modResult = await updateInvoiceInQb({
                      txnId: freshTxnId,
                      salesRep,
                    });
                    if (!modResult.success) {
                      logger.error(
                        `${LOG_PREFIX} ❌ Invoice Mod failed: ${modResult.error}`
                      );
                      return;
                    }
                    logger.info(
                      `${LOG_PREFIX} ✅ Invoice ${freshTxnId} salesRep update queued (op: ${modResult.data?.operationId})`
                    );
                  }
                } else {
                  // No salesRep to update — just cache EditSequence
                  const {
                    bridgeFetch,
                    pollRawOperationResult,
                  } = require("../../../../lib/quickbooks/client/core");
                  const {
                    cacheEditSequence,
                  } = require("../../../../lib/quickbooks/qb-pipeline");
                  const endpoint = isSR ? "sales-receipts" : "invoices";
                  const entityType = isSR ? "sales_receipt" : "invoice";
                  const resp = await bridgeFetch(
                    "GET",
                    `/api/${endpoint}/${freshTxnId}`
                  );
                  if (!resp?.operationId) return;
                  const raw = await pollRawOperationResult(resp.operationId);
                  const editSeq =
                    raw?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet
                      ?.EditSequence ||
                    raw?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet
                      ?.EditSequence ||
                    raw?.InvoiceRet?.EditSequence ||
                    raw?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs
                      ?.SalesReceiptRet?.EditSequence ||
                    raw?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet
                      ?.EditSequence ||
                    raw?.SalesReceiptRet?.EditSequence;
                  if (editSeq) {
                    await cacheEditSequence(
                      entityType,
                      freshTxnId,
                      String(editSeq)
                    );
                    logger.info(
                      `${LOG_PREFIX} ✅ Cached EditSeq for ${entityType} ${freshTxnId}: ${editSeq}`
                    );
                  }
                }
              } else {
                // ── CREATE path ── Intelligent routing: Invoice vs Sales Receipt
                const {
                  data: [parentOrder],
                } = await query.graph({
                  entity: "order",
                  fields: ["metadata", "customer_id", "status"],
                  filters: { id: invoice.order_id },
                });

                const soTxnId = getSoTxnId(parentOrder?.metadata || {});

                if (soTxnId) {
                  logger.info(
                    `${LOG_PREFIX} Intelligent Sync -> Has Sales Order -> Dispatching InvoiceAdd`
                  );
                  await handleFulfillmentCreated(
                    {
                      order_id: invoice.order_id,
                      fulfillment_id: invoice.fulfillment_id,
                      invoice_id: id,
                    },
                    orderModule,
                    customerModule,
                    req.scope,
                    logger
                  );
                } else {
                  logger.info(
                    `${LOG_PREFIX} Intelligent Sync -> No Sales Order -> Dispatching SalesReceiptAdd`
                  );
                  await handleSalesReceiptCreated(
                    {
                      order_id: invoice.order_id,
                      fulfillment_id: invoice.fulfillment_id,
                      invoice_id: id,
                    },
                    orderModule,
                    customerModule,
                    req.scope,
                    logger
                  );
                }
              }
            } catch (bgErr: any) {
              logger.error(
                `${LOG_PREFIX} Background Invoice/SR sync error: ${bgErr.message}`
              );
            }
          },
          { logger }
        );

        return res.json({ success: true, message: "Invoice sync queued" });
      }

      case "payment": {
        const financeService = req.scope.resolve(FINANCE_MODULE);
        const payment = await financeService.retrieveCustomerPayment(id, {
          relations: ["applications"],
        });
        if (!payment)
          return res.status(404).json({ error: "Payment not found" });

        const payTxnId = payment.metadata?.qb_txn_id as string | undefined;
        const paySyncStatus = payment.metadata?.qb_sync_status as
          | string
          | undefined;
        const payInFlight =
          paySyncStatus &&
          ["creating", "editing", "pending"].includes(paySyncStatus);
        if (payTxnId) {
          // Already in QB → fetch + cache EditSequence in background
          (async () => {
            try {
              const {
                bridgeFetch,
                pollRawOperationResult,
              } = require("../../../../lib/quickbooks/client/core");
              const {
                cacheEditSequence,
              } = require("../../../../lib/quickbooks/qb-pipeline");
              const resp = await bridgeFetch(
                "GET",
                `/api/payments/${payTxnId}`
              );
              if (!resp?.operationId) return;
              const raw = await pollRawOperationResult(resp.operationId);
              const editSeq =
                raw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs
                  ?.ReceivePaymentRet?.EditSequence ||
                raw?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet
                  ?.EditSequence ||
                raw?.ReceivePaymentRet?.EditSequence;
              if (editSeq) {
                await cacheEditSequence("payment", payTxnId, String(editSeq));
                logger.info(
                  `${LOG_PREFIX} ✅ Cached EditSeq for payment ${payTxnId}: ${editSeq}`
                );
              }
            } catch (bgErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not refresh payment EditSeq: ${bgErr.message}`
              );
            }
          })();
          return res.json({
            success: true,
            message:
              "Payment already in QuickBooks — EditSequence refresh queued",
          });
        }
        if (payInFlight) {
          return res.status(400).json({
            error: `Cannot sync: Payment is already in progress (status: ${paySyncStatus}).`,
          });
        }

        // Fire-and-forget — double sequence runs in background
        (async () => {
          try {
            logger.info(`${LOG_PREFIX} Sequence 1/2: handlePosPaymentCreated`);
            await handlePosPaymentCreated({
              event: { name: "pos.payment.created", data: { id } },
              container: req.scope as any,
              pluginOptions: {},
            });
            const refreshedPayment =
              await financeService.retrieveCustomerPayment(id, {
                relations: ["applications"],
              });
            if (refreshedPayment.applications?.length > 0) {
              logger.info(
                `${LOG_PREFIX} Sequence 2/2: handlePosPaymentApplied`
              );
              for (const app of refreshedPayment.applications) {
                if (app.invoice_id) {
                  await handlePosPaymentApplied({
                    event: {
                      name: "pos.payment.applied",
                      data: {
                        payment_id: refreshedPayment.id,
                        invoice_id: app.invoice_id,
                        order_id: app.order_id,
                        amount_applied: Number(app.amount_applied),
                      },
                    },
                    container: req.scope as any,
                    pluginOptions: {},
                  });
                }
              }
            } else {
              logger.info(
                `${LOG_PREFIX} Sequence 2/2 skipped: No payment applications found`
              );
            }
          } catch (err: any) {
            logger.error(
              `${LOG_PREFIX} Background payment sync error: ${err.message}`
            );
          }
        })();
        return res.json({ success: true, message: "Payment sync queued" });
      }

      case "return": {
        const financeService = req.scope.resolve(FINANCE_MODULE);
        const payment = await financeService.retrieveCustomerPayment(id);
        // In our POS, Refunds are Customer Payments with type = 'refund'
        if (!payment || payment.type !== "refund")
          return res.status(404).json({ error: "Refund not found" });

        if (payment.metadata?.qb_txn_id) {
          // Already in QB → fetch + cache EditSequence in background
          const refundTxnId = payment.metadata.qb_txn_id as string;
          (async () => {
            try {
              const {
                bridgeFetch,
                pollRawOperationResult,
              } = require("../../../../lib/quickbooks/client/core");
              const {
                cacheEditSequence,
              } = require("../../../../lib/quickbooks/qb-pipeline");
              const resp = await bridgeFetch(
                "GET",
                `/api/checks/${refundTxnId}`
              );
              if (!resp?.operationId) return;
              const raw = await pollRawOperationResult(resp.operationId);
              const editSeq =
                raw?.QBXML?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
                raw?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
                raw?.CheckRet?.EditSequence;
              if (editSeq) {
                await cacheEditSequence(
                  "write_check",
                  refundTxnId,
                  String(editSeq)
                );
                logger.info(
                  `${LOG_PREFIX} ✅ Cached EditSeq for write_check ${refundTxnId}: ${editSeq}`
                );
              }
            } catch (bgErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not refresh refund EditSeq: ${bgErr.message}`
              );
            }
          })();
          return res.json({
            success: true,
            message:
              "Refund already in QuickBooks — EditSequence refresh queued",
          });
        }

        handlePosPaymentCreated({
          event: { name: "pos.payment.created", data: { id } },
          container: req.scope as any,
          pluginOptions: {},
        }).catch((err: any) =>
          logger.error(
            `${LOG_PREFIX} Background refund sync error: ${err.message}`
          )
        );
        return res.json({
          success: true,
          message: "Refund/CreditMemo sync queued",
        });
      }

      case "credit_memo": {
        const creditMemoService = req.scope.resolve("credit_memos") as any;
        const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
          relations: ["items"],
        });
        if (!creditMemo)
          return res.status(404).json({ error: "Credit Memo not found" });

        // Smart void retry: if CM is voided and has a QB TxnID, re-send void to QB (background)
        if (creditMemo.status === "voided" || action === "void") {
          if (!creditMemo.qb_txn_id) {
            return res.status(400).json({
              error:
                "Cannot void in QB: Credit Memo was never synced to QuickBooks.",
            });
          }
          logger.info(
            `${LOG_PREFIX} Retrying QB void for Credit Memo ${creditMemo.credit_memo_number} (TxnID: ${creditMemo.qb_txn_id})`
          );
          (async () => {
            try {
              const {
                voidCreditMemoInQb,
              } = require("../../../../lib/quickbooks/client/credit-memos");
              const {
                writePipelineRow,
              } = require("../../../../lib/quickbooks/qb-pipeline");

              try {
                const qb_ref_number =
                  creditMemo.metadata?.qb_ref_number ||
                  creditMemo.credit_memo_number ||
                  null;
                await writePipelineRow({
                  referenceId: id,
                  referenceType: "credit_memo",
                  step: "void_credit_memo",
                  status: "pending",
                  qbTxnId: creditMemo.qb_txn_id,
                  qbRefNumber: qb_ref_number,
                  medusaRefNumber: creditMemo.credit_memo_number || null,
                });
              } catch (pErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
                );
              }

              const result = await voidCreditMemoInQb(
                creditMemo.qb_txn_id,
                creditMemo.qb_edit_sequence,
                (msg: string) => logger.info(msg)
              );
              if (result.success) {
                await writePipelineRow({
                  referenceId: id,
                  referenceType: "credit_memo",
                  step: "void_credit_memo",
                  status: "submitted",
                  bridgeOpId: result.data?.operationId || null,
                  qbTxnId: creditMemo.qb_txn_id,
                  qbRefNumber:
                    creditMemo.qb_ref_number ??
                    creditMemo.credit_memo_number ??
                    null,
                  medusaRefNumber: creditMemo.credit_memo_number ?? null,
                });
                logger.info(
                  `${LOG_PREFIX} ✅ QB void retry succeeded for ${creditMemo.credit_memo_number}`
                );
              } else {
                logger.error(
                  `${LOG_PREFIX} ❌ QB void retry failed: ${result.error}`
                );
              }
            } catch (bgErr: any) {
              logger.error(
                `${LOG_PREFIX} QB void retry error: ${bgErr.message}`
              );
            }
          })();
          return res.json({
            success: true,
            message: "Credit Memo void queued to QuickBooks",
          });
        }

        if (creditMemo.status !== "completed")
          return res.status(400).json({
            error: "Only completed credit memos can be synced to QuickBooks.",
          });

        const cmTxnId = creditMemo.metadata?.qb_txn_id as string | undefined;
        if (cmTxnId) {
          // Already in QB → fetch + cache EditSequence in background
          (async () => {
            try {
              const {
                bridgeFetch,
                pollRawOperationResult,
              } = require("../../../../lib/quickbooks/client/core");
              const {
                cacheEditSequence,
              } = require("../../../../lib/quickbooks/qb-pipeline");
              const resp = await bridgeFetch(
                "GET",
                `/api/credit-memos/${cmTxnId}`
              );
              if (!resp?.operationId) return;
              const raw = await pollRawOperationResult(resp.operationId);
              const editSeq =
                raw?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet
                  ?.EditSequence ||
                raw?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet
                  ?.EditSequence ||
                raw?.CreditMemoRet?.EditSequence;
              if (editSeq) {
                await cacheEditSequence(
                  "credit_memo",
                  cmTxnId,
                  String(editSeq)
                );
                logger.info(
                  `${LOG_PREFIX} ✅ Cached EditSeq for credit_memo ${cmTxnId}: ${editSeq}`
                );
              }
            } catch (bgErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not refresh credit memo EditSeq: ${bgErr.message}`
              );
            }
          })();
          return res.json({
            success: true,
            message:
              "Credit Memo already in QuickBooks — EditSequence refresh queued",
          });
        }

        const customerModule = req.scope.resolve(Modules.CUSTOMER);
        let customer;
        try {
          customer = await customerModule.retrieveCustomer(
            creditMemo.customer_id,
            { relations: ["addresses"] }
          );
        } catch {
          return res
            .status(404)
            .json({ error: "Customer not found for this Credit Memo." });
        }

        const {
          ensureCustomerInQb,
        } = require("../../../../lib/quickbooks/order-flow-core");
        const custResult: any = await ensureCustomerInQb(
          customer,
          customerModule,
          (m: string) => logger.info(m)
        );

        if (!custResult.success || !custResult.qbCustomerId) {
          return res
            .status(500)
            .json({ error: "Failed to ensure customer in QuickBooks" });
        }

        const qbItems = creditMemo.items.map((item: any) => ({
          productId: item.variant_id || item.product_id,
          productName: item.title,
          quantity: item.quantity,
          price: item.unit_price,
          amount: item.quantity * item.unit_price,
          desc: item.title,
        }));

        const {
          createCreditMemoInQb,
        } = require("../../../../lib/quickbooks/client");
        const cmResult = await createCreditMemoInQb({
          customerId: custResult.qbCustomerId,
          date: creditMemo.completed_at
            ? new Date(creditMemo.completed_at).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0],
          refNumber: creditMemo.credit_memo_number
            ? `CM-${creditMemo.credit_memo_number}`
            : `CM-${creditMemo.id.slice(-6)}`,
          memo: `Medusa POS Credit Memo`,
          items: qbItems,
        });

        if (!cmResult.success) {
          return res.status(500).json({
            error:
              cmResult.error || "Failed to create Credit Memo in QuickBooks",
          });
        }

        return res.json({
          success: true,
          message: "Credit Memo sync queued successfully",
        });
      }

      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err: any) {
    logger.error(`${LOG_PREFIX} Error during manual sync: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
