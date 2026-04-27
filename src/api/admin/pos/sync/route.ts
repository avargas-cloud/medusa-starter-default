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
                // ── EDIT path ── Force Sync: send FULL payload (items + discounts
                // + shipping + salesRep + tax) and write pipeline row for
                // UI visibility. Regular Save uses /admin/invoices/:id/sync-qb-rep
                // and /update-tax for lightweight updates.
                const isSR = !!(
                  freshInvoice.metadata?.qb_sales_receipt_txn_id ||
                  freshInvoice.metadata?.is_sales_receipt === true ||
                  freshInvoice.metadata?.is_sales_receipt === "true"
                );

                const {
                  data: [parentOrder],
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
                  filters: { id: invoice.order_id },
                });
                const salesRep = parseSalesRepInitials(
                  parentOrder?.metadata?.sales_rep
                );

                const {
                  buildQbItems,
                  buildShippingQbItem,
                  buildQbOrderDiscountLines,
                } = require("../../../../lib/quickbooks/order-flow-core");
                const {
                  getQbConfig,
                } = require("../../../../lib/quickbooks/handlers/utils");
                const {
                  writePipelineRow,
                } = require("../../../../lib/quickbooks/qb-pipeline");

                const qbConfig = await getQbConfig();
                const activeItems = (parentOrder?.items || [])
                  .filter((item: any) => (item.quantity ?? 0) > 0)
                  .map((item: any) => ({
                    ...item,
                    unit_price: Number(item.unit_price || 0),
                    subtotal: undefined,
                  }));

                // Fresh-resolve variant metadata: if a variant's quickbooks_id
                // was added AFTER the order was created, re-query it here so
                // the item isn't silently dropped by buildQbItems' filter.
                const variantIdsToRefresh = Array.from(
                  new Set(
                    activeItems
                      .filter(
                        (i: any) =>
                          i.variant_id && !i.variant?.metadata?.quickbooks_id
                      )
                      .map((i: any) => i.variant_id)
                  )
                );
                if (variantIdsToRefresh.length > 0) {
                  try {
                    const { data: freshVariants } = await query.graph({
                      entity: "product_variant",
                      fields: ["id", "metadata", "sku"],
                      filters: { id: variantIdsToRefresh as string[] },
                    });
                    const byId = new Map(
                      (freshVariants || []).map((v: any) => [v.id, v])
                    );
                    for (const it of activeItems) {
                      if (
                        !it.variant?.metadata?.quickbooks_id &&
                        it.variant_id &&
                        byId.has(it.variant_id)
                      ) {
                        const fresh: any = byId.get(it.variant_id);
                        if (fresh?.metadata?.quickbooks_id) {
                          it.variant = {
                            ...(it.variant || {}),
                            metadata: {
                              ...(it.variant?.metadata || {}),
                              ...(fresh.metadata || {}),
                            },
                          };
                          logger.info(
                            `${LOG_PREFIX} Fresh-resolved quickbooks_id for variant ${it.variant_id} (sku=${fresh.sku})`
                          );
                        }
                      }
                    }
                  } catch (rErr: any) {
                    logger.warn(
                      `${LOG_PREFIX} ⚠️ Could not fresh-resolve variant metadata: ${rErr.message}`
                    );
                  }
                }

                // Warn about items that still lack quickbooks_id — they'll be
                // silently dropped by buildQbItems so QB will miss those lines.
                const missingQb = activeItems.filter(
                  (i: any) => !i.variant?.metadata?.quickbooks_id
                );
                if (missingQb.length > 0) {
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ ${missingQb.length} item(s) lack quickbooks_id and will NOT sync to QB: ${missingQb
                      .map((i: any) => i.variant?.sku || i.title || i.id)
                      .join(", ")}`
                  );
                }

                const qbItems = buildQbItems(
                  activeItems,
                  parentOrder?.metadata || {}
                );

                const discountTotal = Number(parentOrder?.discount_total || 0);
                if (discountTotal > 0) {
                  const subtotal = Number(parentOrder?.subtotal || 0);
                  const pct =
                    subtotal > 0 ? (discountTotal / subtotal) * 100 : null;
                  buildQbOrderDiscountLines(discountTotal, pct).forEach(
                    (l: any) => qbItems.push(l)
                  );
                }

                const shippingItem = buildShippingQbItem(
                  parentOrder?.shipping_methods || [],
                  qbConfig.shippingItemId
                );
                if (shippingItem) qbItems.push(shippingItem);

                const hasTax =
                  parentOrder?.tax_total && parentOrder.tax_total > 0;
                const salesTaxCode = hasTax
                  ? qbConfig.defaultSalesTaxCode
                  : undefined;

                // ── Match Medusa items to existing QB lines via TxnLineID ──
                // QBXML requires every InvoiceLineMod/SalesReceiptLineMod to
                // carry a TxnLineID (real one = update, "-1" = append new).
                // Lines present in QB but not matched to any Medusa item get
                // dropped from the payload, which QB interprets as "delete".
                try {
                  const {
                    fetchInvoiceLinesFromQb,
                  } = require("../../../../lib/quickbooks/client/invoices");
                  const {
                    fetchSalesReceiptLinesFromQb,
                  } = require("../../../../lib/quickbooks/client/sales-receipts");

                  const snapshot = isSR
                    ? await fetchSalesReceiptLinesFromQb(freshTxnId)
                    : await fetchInvoiceLinesFromQb(freshTxnId);

                  const availableLines = [...(snapshot?.lines || [])];
                  logger.info(
                    `${LOG_PREFIX} Pulled ${availableLines.length} existing QB line(s) from ${isSR ? "SalesReceipt" : "Invoice"} ${freshTxnId}`
                  );

                  for (const it of qbItems) {
                    const targetId = (it as any).productId;
                    const targetName = (it as any).productName;
                    const qty = Number((it as any).quantity ?? 0);
                    const amt = Number((it as any).amount ?? 0);
                    const matchesItem = (l: any) =>
                      (targetId && l.ItemListID === targetId) ||
                      (!targetId &&
                        targetName &&
                        l.ItemFullName === targetName);
                    const idxExact = availableLines.findIndex(
                      (l) =>
                        matchesItem(l) &&
                        (qty === 0 ||
                          Math.abs((l.Quantity ?? 0) - qty) < 0.001) &&
                        (amt === 0 || Math.abs((l.Amount ?? 0) - amt) < 0.01)
                    );
                    const idx =
                      idxExact >= 0
                        ? idxExact
                        : availableLines.findIndex((l) => matchesItem(l));
                    if (idx >= 0) {
                      const matched = availableLines[idx];
                      (it as any).TxnLineID = matched.TxnLineID;
                      // If QB's existing line had no InventorySiteRef, the item
                      // is a service/non-inventory type — don't re-emit Site or
                      // QB throws error 3140 ("Site cannot be set on a
                      // non-inventory lineitem"). Preserve an explicit noSite
                      // already set by the backend (shipping/discount).
                      if (matched.hasSite === false) {
                        (it as any).noSite = true;
                      }
                      availableLines.splice(idx, 1);
                    } else {
                      (it as any).TxnLineID = "-1";
                    }
                  }

                  if (availableLines.length > 0) {
                    logger.info(
                      `${LOG_PREFIX} ${availableLines.length} QB line(s) had no match in Medusa and will be removed from the document`
                    );
                  }
                } catch (mErr: any) {
                  logger.error(
                    `${LOG_PREFIX} ❌ Could not pull existing QB lines — aborting Force Sync: ${mErr.message}`
                  );
                  try {
                    await writePipelineRow({
                      orderId: invoice.order_id,
                      step: isSR ? "sales_receipt_update" : "invoice_update",
                      status: "failed",
                      error: `Line snapshot fetch failed: ${mErr.message}`,
                      qbTxnId: freshTxnId,
                      medusaRefNumber: freshInvoice.invoice_number
                        ? `INV-${freshInvoice.invoice_number}`
                        : null,
                    });
                  } catch {}
                  return;
                }

                const pipelineStep = isSR
                  ? "sales_receipt_update"
                  : "invoice_update";
                const medusaRefNumber = freshInvoice.invoice_number
                  ? `INV-${freshInvoice.invoice_number}`
                  : null;

                try {
                  await writePipelineRow({
                    orderId: invoice.order_id,
                    step: pipelineStep,
                    status: "pending",
                    qbTxnId: freshTxnId,
                    medusaRefNumber,
                  });
                } catch (pErr: any) {
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Could not write pending pipeline row: ${pErr.message}`
                  );
                }

                logger.info(
                  `${LOG_PREFIX} Force Sync → ${isSR ? "SalesReceiptMod" : "InvoiceMod"} ${freshTxnId} with ${qbItems.length} items`
                );

                const modPayload: any = {
                  txnId: freshTxnId,
                  items: qbItems,
                  ...(salesRep ? { salesRep } : {}),
                  ...(salesTaxCode ? { salesTaxCode } : { taxExempt: true }),
                };

                const modResult = isSR
                  ? await require("../../../../lib/quickbooks/client/sales-receipts").updateSalesReceiptInQb(
                      modPayload
                    )
                  : await require("../../../../lib/quickbooks/client/invoices").updateInvoiceInQb(
                      modPayload
                    );

                if (!modResult.success) {
                  logger.error(
                    `${LOG_PREFIX} ❌ ${isSR ? "Sales Receipt" : "Invoice"} Mod failed: ${modResult.error}`
                  );
                  try {
                    await writePipelineRow({
                      orderId: invoice.order_id,
                      step: pipelineStep,
                      status: "failed",
                      error: modResult.error,
                      qbTxnId: freshTxnId,
                      medusaRefNumber,
                    });
                  } catch {}
                  return;
                }

                try {
                  await writePipelineRow({
                    orderId: invoice.order_id,
                    step: pipelineStep,
                    status: "submitted",
                    bridgeOpId: modResult.data?.operationId || null,
                    qbTxnId: freshTxnId,
                    medusaRefNumber,
                  });
                } catch {}

                logger.info(
                  `${LOG_PREFIX} ✅ ${isSR ? "Sales Receipt" : "Invoice"} ${freshTxnId} full sync queued (op: ${modResult.data?.operationId})`
                );
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
        const cmSalesRepRef = parseSalesRepInitials(
          (creditMemo as any).sales_rep
        );
        const cmResult = await createCreditMemoInQb({
          customerId: custResult.qbCustomerId,
          date: creditMemo.completed_at
            ? new Date(creditMemo.completed_at).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0],
          memo: `Medusa POS Credit Memo`,
          items: qbItems,
          ...(cmSalesRepRef ? { salesRepRef: cmSalesRepRef } : {}),
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
