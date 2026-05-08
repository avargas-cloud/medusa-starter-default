import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

// 1.5.7: handleFulfillmentCreated import removed — pos/sync enqueues now.
// 1.5.5: handleOrderPlaced import removed — pos/sync enqueues now.
// 1.5.9: handlePosPaymentApplied + handlePosPaymentCreated imports removed —
// pos/sync now enqueues pipeline rows for the consolidator.
// 1.5.6: handleSalesReceiptCreated import removed — pos/sync enqueues now.
import { parseSalesRepInitials } from "../../../../lib/quickbooks/parse-sales-rep";
import { orderPurchaseOrderModLines } from "../../../../lib/quickbooks/purchase-order-line-order";
import {
  getEstimateTxnId,
  getSoTxnId,
} from "../../../../lib/quickbooks/qb-metadata-types";
import { withQbSerialized } from "../../../../lib/quickbooks/qb-serializer";
import { FINANCE_MODULE } from "../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../modules/invoices";
import { PURCHASE_ORDERS_MODULE } from "../../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../../modules/purchase-orders/service";
// 1.5.4: handleDraftOrderCreated import removed — pos/sync now enqueues
// 'pending' rows for the consolidator's pending-dispatch pass.

const LOG_PREFIX = "[POST /admin/pos/sync]";

function poMemoNumber(poNumber: string): string {
  return poNumber.replace(/^PO-/i, "");
}

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
    // 1.5.7: customerModule no longer needed at this scope — handler calls
    // that used it have been replaced with pipeline enqueue.

    switch (type) {
      case "purchase_order": {
        if (action === "void") {
          return res.status(400).json({
            error: "Use the Purchase Order void route for PO voids.",
          });
        }

        const service = req.scope.resolve(
          PURCHASE_ORDERS_MODULE
        ) as unknown as PurchaseOrdersModuleService;
        const knex = (req.scope as any).resolve("__pg_connection__");

        const [po] = (await service.listPurchaseOrders(
          { id },
          { take: 1, skip: 0 }
        )) as Array<{
          id: string;
          number: string | null;
          status: string;
          vendor_id: string;
          vendor_name_snapshot: string | null;
          vendor_qb_list_id_snapshot: string | null;
          ordered_at: string | Date | null;
          expected_at: string | Date | null;
          reference_number: string | null;
          qb_purchase_order_list_id: string | null;
          qb_edit_sequence: string | null;
        }>;

        if (!po) {
          return res.status(404).json({ error: "Purchase Order not found" });
        }
        if (!po.qb_purchase_order_list_id) {
          return res.status(400).json({
            error: "Cannot force MOD: Purchase Order is not in QuickBooks.",
          });
        }
        if (["draft", "cancelled", "voided"].includes(po.status)) {
          return res.status(400).json({
            error: `Cannot force MOD for PO status ${po.status}.`,
          });
        }

        const lines = (await service.listPurchaseOrderLines(
          { purchase_order_id: id },
          { take: 1000, skip: 0, order: { line_order: "ASC", created_at: "ASC" } }
        )) as Array<{
          id: string;
          sku_snapshot: string;
          description_snapshot: string;
          qty_ordered: number;
          unit_cost_cents: number;
          qb_item_list_id_snapshot: string | null;
          qb_txn_line_id?: string | null;
        }>;

        const modPayload = {
          is_mod: true,
          txn_id: po.qb_purchase_order_list_id,
          edit_sequence: po.qb_edit_sequence ?? undefined,
          po_id: id,
          po_number: po.number ?? undefined,
          vendor_qb_list_id: po.vendor_qb_list_id_snapshot ?? null,
          vendor_name: po.vendor_name_snapshot ?? po.vendor_id,
          ordered_at: po.ordered_at ? new Date(po.ordered_at).toISOString() : null,
          expected_at: po.expected_at ? new Date(po.expected_at).toISOString() : null,
          memo: `Medusa PO ${poMemoNumber(po.number ?? id)}`,
          reference_number: po.reference_number ?? null,
          lines: orderPurchaseOrderModLines(lines).map((line) => ({
            line_id: line.id,
            qb_txn_line_id: line.qb_txn_line_id ?? null,
            qb_item_list_id: line.qb_item_list_id_snapshot,
            sku: line.sku_snapshot,
            description: line.description_snapshot,
            qty_ordered: line.qty_ordered,
            unit_cost_cents: line.unit_cost_cents,
          })),
        };

        const updated = await knex.raw(
          `UPDATE qb_purchase_order_pipeline
              SET status          = 'waiting',
                  qb_operation_id = NULL,
                  payload         = ?,
                  retries         = 0,
                  last_error      = NULL,
                  next_retry_at   = NULL,
                  synced_at       = NULL,
                  updated_at      = NOW()
            WHERE purchase_order_id = ?
              AND deleted_at IS NULL`,
          [JSON.stringify(modPayload), id]
        );

        if ((updated.rowCount ?? 0) === 0) {
          await service.createQbPurchaseOrderPipelines([
            { purchase_order_id: id, status: "waiting", payload: modPayload },
          ]);
        }

        return res.json({
          success: true,
          message: "Purchase Order MOD queued",
        });
      }

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
                  "items.adjustments.*",
                  "shipping_methods.*",
                ],
                filters: { id },
              });
              if (!freshOrder) return;

              const freshTxnId = getEstimateTxnId(freshOrder.metadata || {});

              if (freshTxnId) {
                const {
                  writePipelineRow: enqueueEstimateMod,
                } = require("../../../../lib/quickbooks/qb-pipeline");
                await enqueueEstimateMod({
                  orderId: id,
                  step: "estimate",
                  status: "pending",
                  qbTxnId: freshTxnId,
                  medusaRefNumber:
                    (freshOrder.metadata as any)?.document_number ?? null,
                  payload: { forceMod: true },
                });
                logger.info(
                  `${LOG_PREFIX} Estimate already exists (${freshTxnId}) — enqueued forced EstimateMod`
                );
              } else {
                // ── CREATE path ──
                logger.info(
                  `${LOG_PREFIX} No estimate in QB yet — enqueuing for consolidator`
                );
                // 1.5.4: enqueue 'pending' for consolidator pending-dispatch.
                const {
                  writePipelineRow: enqueue,
                } = require("../../../../lib/quickbooks/qb-pipeline");
                await enqueue({
                  orderId: id,
                  step: "estimate",
                  status: "pending",
                });
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
                const {
                  writePipelineRow: enqueueSalesOrderMod,
                } = require("../../../../lib/quickbooks/qb-pipeline");
                await enqueueSalesOrderMod({
                  orderId: id,
                  step: "sales_order",
                  status: "pending",
                  qbTxnId: freshSoTxnId,
                  medusaRefNumber:
                    (freshOrder.metadata as any)?.document_number ?? null,
                  payload: { forceMod: true },
                });
                logger.info(
                  `${LOG_PREFIX} SO already exists (${freshSoTxnId}) — enqueued forced SalesOrderMod`
                );
              } else {
                // ── CREATE path ──
                logger.info(
                  `${LOG_PREFIX} No SO in QB yet — enqueuing for consolidator`
                );
                // 1.5.5: enqueue 'pending' SO row.
                const {
                  writePipelineRow: enqueueSo2,
                } = require("../../../../lib/quickbooks/qb-pipeline");
                await enqueueSo2({
                  orderId: id,
                  step: "sales_order",
                  status: "pending",
                });
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
              const freshInvoice = await invoiceService.retrievePosInvoice(id, {
                relations: ["items"],
              });
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
                const parentItemsByVariant = new Map<string, any>(
                  (parentOrder?.items || [])
                    .filter((item: any) => item.variant_id)
                    .map((item: any) => [item.variant_id, item])
                );
                const activeItems = ((freshInvoice as any).items || [])
                  .filter((item: any) => (item.quantity ?? 0) > 0)
                  .map((item: any) => {
                    const parentItem = item.variant_id
                      ? parentItemsByVariant.get(item.variant_id)
                      : null;
                    return {
                      ...(parentItem || {}),
                      id: parentItem?.id ?? item.id,
                      variant_id: item.variant_id,
                      variant: parentItem?.variant ?? {
                        id: item.variant_id,
                        sku: item.sku,
                        metadata: {},
                      },
                      title:
                        parentItem?.title ||
                        parentItem?.product_title ||
                        item.description ||
                        item.sku ||
                        "",
                      product_title:
                        parentItem?.product_title ||
                        parentItem?.title ||
                        item.description ||
                        item.sku ||
                        "",
                      quantity: Number(item.quantity || 0),
                      unit_price: Number(item.unit_price || 0) / 100,
                      subtotal: Number(item.total || 0) / 100,
                      metadata: {
                        ...(parentItem?.metadata || {}),
                        sales_description:
                          item.description ||
                          parentItem?.metadata?.sales_description,
                      },
                    };
                  });

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

                const {
                  getEffectiveOrderDiscount,
                } = require("../../../../lib/quickbooks/order-flow-core");
                const invoiceDiscount = Number((freshInvoice as any).discount);
                const discountTotal =
                  Number.isFinite(invoiceDiscount) && invoiceDiscount > 0
                    ? invoiceDiscount / 100
                    : getEffectiveOrderDiscount(parentOrder);
                if (discountTotal > 0) {
                  const subtotal =
                    Number((freshInvoice as any).subtotal || 0) / 100 ||
                    Number(parentOrder?.subtotal || 0);
                  const pct =
                    subtotal > 0 ? (discountTotal / subtotal) * 100 : null;
                  buildQbOrderDiscountLines(discountTotal, pct).forEach(
                    (l: any) => qbItems.push(l)
                  );
                }

                const shippingItem = buildShippingQbItem(
                  (freshInvoice as any).shipping !== undefined &&
                    (freshInvoice as any).shipping !== null
                    ? Number((freshInvoice as any).shipping) > 0
                      ? [
                          {
                            name: "Shipping",
                            amount: Number((freshInvoice as any).shipping) / 100,
                          },
                        ]
                      : []
                    : parentOrder?.shipping_methods || [],
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
                      referenceId: id,
                      referenceType: "pos_invoice",
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
                    referenceId: id,
                    referenceType: "pos_invoice",
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
                  memo: freshInvoice.invoice_number
                    ? `POS Invoice ${freshInvoice.invoice_number}`
                    : undefined,
                  ...(salesRep ? { salesRep } : {}),
                  ...(salesTaxCode ? { salesTaxCode } : { taxExempt: true }),
                };

                await writePipelineRow({
                  orderId: invoice.order_id,
                  referenceId: id,
                  referenceType: "pos_invoice",
                  step: pipelineStep,
                  status: "pending",
                  qbTxnId: freshTxnId,
                  medusaRefNumber,
                  payload: modPayload,
                });

                logger.info(
                  `${LOG_PREFIX} ✅ ${isSR ? "Sales Receipt" : "Invoice"} ${freshTxnId} full MOD enqueued`
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
                    `${LOG_PREFIX} Intelligent Sync -> Has Sales Order -> enqueuing invoice`
                  );
                  // 1.5.7: pipeline-only — enqueue.
                  const {
                    writePipelineRow: enqueueInvPos,
                  } = require("../../../../lib/quickbooks/qb-pipeline");
                  await enqueueInvPos({
                    orderId: invoice.order_id,
                    referenceId: id,
                    referenceType: "invoice",
                    step: "invoice",
                    status: "pending",
                    payload: {
                      invoice_id: id,
                      fulfillment_id: invoice.fulfillment_id,
                    },
                  });
                } else {
                  logger.info(
                    `${LOG_PREFIX} Intelligent Sync -> No Sales Order -> enqueuing sales_receipt`
                  );
                  // 1.5.6: pipeline-only — enqueue.
                  const {
                    writePipelineRow: enqueueSrPos,
                  } = require("../../../../lib/quickbooks/qb-pipeline");
                  await enqueueSrPos({
                    orderId: invoice.order_id,
                    referenceId: id,
                    referenceType: "invoice",
                    step: "sales_receipt",
                    status: "pending",
                    payload: {
                      invoice_id: id,
                      fulfillment_id: invoice.fulfillment_id,
                    },
                  });
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
          // Already in QB → fetch/cache EditSequence, then re-enqueue each
          // payment application. This lets Manual Sync repair cases where the
          // ReceivePayment exists but one invoice application was missed.
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

              const {
                writePipelineRow: enqueueExistingPayApply,
              } = require("../../../../lib/quickbooks/qb-pipeline");
              const refreshedPayment =
                await financeService.retrieveCustomerPayment(id, {
                  relations: ["applications"],
                });
              for (const app of refreshedPayment.applications || []) {
                if (!app.invoice_id || app.voided_at) continue;
                await enqueueExistingPayApply({
                  orderId: app.order_id ?? null,
                  referenceId: app.id,
                  referenceType: "payment_application",
                  step: "apply_payment",
                  status: "pending",
                  payload: {
                    payment_id: refreshedPayment.id,
                    invoice_id: app.invoice_id,
                    order_id: app.order_id,
                    amount_applied: Number(app.amount_applied),
                    application_id: app.id,
                  },
                });
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

        // 1.5.9: pipeline-only — enqueue 'payment' + 'apply_payment' rows.
        // The consolidator's pending-dispatch handles both in sequence
        // (apply_payment naturally waits because it depends on payment data
        // available after payment row confirms).
        (async () => {
          try {
            const {
              writePipelineRow: enqueuePosPay,
            } = require("../../../../lib/quickbooks/qb-pipeline");

            logger.info(`${LOG_PREFIX} 📥 Enqueueing payment for ${id}`);
            await enqueuePosPay({
              referenceId: id,
              referenceType: "payment",
              step: "payment",
              status: "pending",
            });

            const refreshedPayment =
              await financeService.retrieveCustomerPayment(id, {
                relations: ["applications"],
              });
            if (refreshedPayment.applications?.length > 0) {
              logger.info(
                `${LOG_PREFIX} 📥 Enqueueing ${refreshedPayment.applications.length} apply_payment row(s)`
              );
              for (const app of refreshedPayment.applications) {
                if (app.invoice_id) {
                  await enqueuePosPay({
                    orderId: app.order_id ?? null,
                    referenceId: app.id,
                    referenceType: "payment_application",
                    step: "apply_payment",
                    status: "pending",
                    payload: {
                      payment_id: refreshedPayment.id,
                      invoice_id: app.invoice_id,
                      order_id: app.order_id,
                      amount_applied: Number(app.amount_applied),
                      application_id: app.id,
                    },
                  });
                }
              }
            } else {
              logger.info(
                `${LOG_PREFIX} No payment applications to enqueue`
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

        // 1.5.9: pipeline-only — enqueue 'payment' for consolidator pickup.
        try {
          const {
            writePipelineRow: enqueueRefundPay,
          } = require("../../../../lib/quickbooks/qb-pipeline");
          await enqueueRefundPay({
            referenceId: id,
            referenceType: "payment",
            step: "payment",
            status: "pending",
          });
        } catch (err: any) {
          logger.error(
            `${LOG_PREFIX} Refund payment enqueue error: ${err.message}`
          );
        }
        return res.json({
          success: true,
          message: "Refund/CreditMemo sync enqueued — consolidator will process",
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
              // 1.5.8: voidCreditMemoInQb removed — only writePipelineRow needed.
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

              // 1.5.8: pipeline-only — enqueue 'pending' void.
              await writePipelineRow({
                referenceId: id,
                referenceType: "credit_memo",
                step: "void_credit_memo",
                status: "pending",
                qbTxnId: creditMemo.qb_txn_id,
                qbRefNumber:
                  creditMemo.qb_ref_number ??
                  creditMemo.credit_memo_number ??
                  null,
                medusaRefNumber: creditMemo.credit_memo_number ?? null,
                payload: {
                  editSequence: creditMemo.qb_edit_sequence,
                },
              });
              logger.info(
                `${LOG_PREFIX} 📥 Enqueued void_credit_memo for ${creditMemo.credit_memo_number}`
              );
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

        const cmTxnId =
          (creditMemo.qb_txn_id as string | undefined) ??
          (creditMemo.metadata?.qb_txn_id as string | undefined);
        if (cmTxnId) {
          const {
            writePipelineRow: enqueueCreditMemoMod,
          } = require("../../../../lib/quickbooks/qb-pipeline");
          await enqueueCreditMemoMod({
            referenceId: id,
            referenceType: "credit_memo",
            step: "credit_memo_mod",
            status: "pending",
            qbTxnId: cmTxnId,
            medusaRefNumber: creditMemo.credit_memo_number ?? null,
            payload: {
              memo: "Medusa POS Credit Memo",
              salesRepRef: parseSalesRepInitials(
                (creditMemo as any).sales_rep
              ),
            },
          });
          return res.json({
            success: true,
            message:
              "Credit Memo MOD enqueued — consolidator will process",
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

        // 1.5.8: pipeline-only — enqueue 'pending' credit_memo with full payload.
        const cmSalesRepRef = parseSalesRepInitials(
          (creditMemo as any).sales_rep
        );
        const {
          writePipelineRow: enqueueCmCreate,
        } = require("../../../../lib/quickbooks/qb-pipeline");
        await enqueueCmCreate({
          referenceId: id,
          referenceType: "credit_memo",
          step: "credit_memo",
          status: "pending",
          medusaRefNumber: creditMemo.credit_memo_number ?? null,
          payload: {
            customerId: custResult.qbCustomerId,
            date: creditMemo.completed_at
              ? new Date(creditMemo.completed_at).toISOString().split("T")[0]
              : new Date().toISOString().split("T")[0],
            memo: `Medusa POS Credit Memo`,
            items: qbItems,
            ...(cmSalesRepRef ? { salesRepRef: cmSalesRepRef } : {}),
          },
        });

        return res.json({
          success: true,
          message: "Credit Memo sync enqueued — consolidator will process",
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
