import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  processInvoiceInQb,
  buildQbItems,
  resolveProductTaxableMap,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
  getEffectiveOrderDiscount,
} from "../order-flow-core";
import { parseSalesRepInitials } from "../parse-sales-rep";
import {
  buildInvoicePatch,
  getEstimateTxnId,
  getSoTxnId,
  getLatestPaymentTxnId,
} from "../qb-metadata-types";
import {
  coalesceIfInFlight,
  writePipelineRow,
  requireQbCustomer,
  cacheEditSequence,
  skipSalesOrderPipelineRow,
} from "../qb-pipeline";

import { handleOrderPlaced } from "./handle-order-placed";
import { LOG_PREFIX, getQbConfig, getFloat } from "./utils";
import { resolveTaxListid } from "../resolve-tax-listid";

function normalizePosInvoicePayloadItems(items: any[]): any[] {
  return items.map((item) => ({
    ...item,
    unit_price:
      item.unit_price !== undefined && item.unit_price !== null
        ? Number(item.unit_price) / 100
        : item.unit_price,
    total:
      item.total !== undefined && item.total !== null
        ? Number(item.total) / 100
        : item.total,
  }));
}

export async function handleFulfillmentCreated(
  data: any,
  orderModule: any,
  customerModule: any,
  _container: any,
  logger: any
) {
  const orderId = data.order_id || data.id;
  logger.info(
    `${LOG_PREFIX} ── order.fulfillment_created → orderId=${orderId} ──`
  );
  logger.info(`${LOG_PREFIX} Fulfillment event data: ${JSON.stringify(data)}`);

  const invoiceReferenceId = data.invoice_id || data.fulfillment_id || null;
  const invoiceReferenceType = data.invoice_id
    ? "pos_invoice"
    : data.fulfillment_id
      ? "fulfillment"
      : null;
  let invoiceMedusaRefNumber: string | null = null;

  // Coalesce rapid saves: if an invoice op is already in-flight, mark next_payload
  // and return — consolidator will re-submit after current op confirms.
  const coalescedInv = await coalesceIfInFlight(
    orderId,
    invoiceReferenceId,
    "invoice"
  );
  if (coalescedInv) {
    logger.info(
      `${LOG_PREFIX} ⏸ Invoice in-flight for ${orderId} — coalesced as next submit`
    );
    return;
  }

  let order: any;
  try {
    const query = _container.resolve(ContainerRegistrationKeys.QUERY);
    const {
      data: [fetchedOrder],
    } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "metadata",
        "tax_total",
        "total",
        "sales_channel_id",
        "customer_id",
        "subtotal",
        "discount_total",
        "promotions.*",
        "promotions.application_method.*",
        "items.*",
        "items.item.unit_price",
        "items.variant.*",
        "items.variant.metadata",
        "items.adjustments.*",
        "customer.*",
        "customer.metadata",
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });

    if (!fetchedOrder)
      throw new Error(`Query returned no order for id ${orderId}`);
    order = fetchedOrder;
    logger.info(
      `${LOG_PREFIX} Order fetched for Invoice: #${order.display_id}, customer_id=${order.customer_id}`
    );
    logger.info(
      `${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`
    );
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`
    );
    return;
  }

  let qbCustomerId: string | undefined = order.metadata?.qb_list_id;

  if (!qbCustomerId && order.customer_id) {
    const check = await requireQbCustomer({
      customerId: order.customer_id,
      orderId,
      step: "invoice",
      selfReferenceId: data.invoice_id || data.fulfillment_id || null,
      selfReferenceType: data.invoice_id
        ? "pos_invoice"
        : data.fulfillment_id
          ? "fulfillment"
          : null,
    });
    if ("waiting" in check) {
      logger.info(
        `${LOG_PREFIX} ⏸ Waiting on customer ${order.customer_id} (customer row ${check.customerRowId}) before submitting Invoice`
      );
      return;
    }
    qbCustomerId = check.qbListId;
  }

  let qbSoTxnId: string | undefined = getSoTxnId(order.metadata);
  const qbPaymentTxnId: string | undefined = getLatestPaymentTxnId(
    order.metadata
  );

  logger.info(
    `${LOG_PREFIX} QB data — customerId=${qbCustomerId ?? "MISSING"}, soTxnId=${qbSoTxnId ?? "MISSING"}, paymentTxnId=${qbPaymentTxnId ?? "none"}`
  );

  if (!qbCustomerId) {
    logger.warn(
      `${LOG_PREFIX} ❌ Missing customer_id on order ${orderId} — cannot create Invoice.`
    );
    return;
  }

  let fulfillmentAmount = order.total || 0;
  let isPartial = false;
  let fulfillmentItems: any[] =
    data.items && Array.isArray(data.items)
      ? normalizePosInvoicePayloadItems(data.items)
      : [];

  if (data.fulfillment_id && fulfillmentItems.length === 0) {
    try {
      const query = _container.resolve(ContainerRegistrationKeys.QUERY);
      const {
        data: [fulfillment],
      } = await query.graph({
        entity: "fulfillment",
        fields: ["items.*"],
        filters: { id: data.fulfillment_id },
      });
      if (fulfillment && fulfillment.items) {
        fulfillmentItems = fulfillment.items;
      }
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} Failed to fetch fulfillment items: ${e.message}`
      );
    }
  }

  // Defense-in-depth: if a POS invoice arrives without items in the payload
  // (subscriber stomp, retry, dual event), reload the snapshot from
  // pos_invoice_item. Prevents isPartial from defaulting to false and keeps
  // LinkToTxnLineID per line so QB SO BO decrements correctly. History:
  // QB Inv 19507 (POS 20330) became standalone because handler had no
  // item-level fallback for invoice_id (2026-05-11).
  if (data.invoice_id && fulfillmentItems.length === 0) {
    try {
      const fbPool = getDbPool();
      const { rows: invRows } = await fbPool.query(
        `SELECT variant_id, sku, quantity, unit_price, total
           FROM pos_invoice_item
          WHERE invoice_id = $1 AND deleted_at IS NULL`,
        [data.invoice_id]
      );
      if (invRows.length > 0) {
        fulfillmentItems = normalizePosInvoicePayloadItems(invRows);
        logger.info(
          `${LOG_PREFIX} ✅ Fallback: loaded ${invRows.length} item(s) from pos_invoice_item for invoice ${data.invoice_id}`
        );
      }
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} Failed to fetch pos_invoice_item fallback: ${e.message}`
      );
    }
  }

  if (fulfillmentItems.length > 0) {
    const orderItemsMap = new Map<string, any>(
      (order.items || []).map((i: any) => [i.id, i])
    );
    const partialTotal = fulfillmentItems.reduce((sum: number, fi: any) => {
      const orderItem = orderItemsMap.get(fi.item_id || fi.id);
      if (!orderItem) return sum;
      return sum + orderItem.unit_price * fi.quantity;
    }, 0);

    const totalOrderQty = (order.items || []).reduce(
      (sum: number, i: any) => sum + i.quantity,
      0
    );
    const fulfillmentQty = fulfillmentItems.reduce(
      (sum: number, fi: any) => sum + fi.quantity,
      0
    );

    if (fulfillmentQty < totalOrderQty) {
      isPartial = true;
    }

    if (partialTotal > 0) fulfillmentAmount = partialTotal;
    const fAmountFloat = getFloat(fulfillmentAmount);
    const oTotalFloat = getFloat(order.total || 0);
    logger.info(
      `${LOG_PREFIX} Fulfillment: $${fAmountFloat.toFixed(2)} of $${oTotalFloat.toFixed(2)} total (isPartial: ${isPartial})`
    );
  } else {
    const fAmountFloat = getFloat(fulfillmentAmount);
    logger.info(
      `${LOG_PREFIX} Full fulfillment: $${fAmountFloat.toFixed(2)} (no item details resolved)`
    );
  }

  const qbEstimateTxnId = getEstimateTxnId(order.metadata);

  if (!qbSoTxnId) {
    if (isPartial) {
      logger.info(
        `${LOG_PREFIX} ⚠️ Partial fulfillment detected but NO Sales Order exists yet! Real-Time Smart Lazy Evaluation: Forcing Sales Order creation before Invoice...`
      );
      await handleOrderPlaced(
        { id: orderId },
        orderModule,
        customerModule,
        _container,
        logger,
        true
      );

      const refreshedOrder = await orderModule.retrieveOrder(orderId);
      qbSoTxnId = getSoTxnId(refreshedOrder.metadata || {});
      logger.info(
        `${LOG_PREFIX} 🔄 Post-Lazy-Eval soTxnId=${qbSoTxnId ?? "FAILED TO CREATE"}`
      );
    } else if (qbEstimateTxnId) {
      logger.info(
        `${LOG_PREFIX} ℹ️ 100% fulfillment derived from Estimate. Linking Invoice directly to Estimate ${qbEstimateTxnId} (skipping SO).`
      );
    } else {
      logger.info(
        `${LOG_PREFIX} ℹ️ No linked documents found (100% fulfillment) — creating a STANDALONE INVOICE directly.`
      );
    }
  }

  const linkedTxnId = qbSoTxnId || (!isPartial ? qbEstimateTxnId : undefined);

  const pool = getDbPool();
  let memo: string | undefined;
  let invoiceShippingAmount: number | undefined;
  let invoiceDiscountAmount: number | undefined;

  try {
    let sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount FROM pos_invoice WHERE fulfillment_id = $1 LIMIT 1`;
    let params: any[] = [data.fulfillment_id];

    if (data.invoice_id) {
      sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount FROM pos_invoice WHERE id = $1 LIMIT 1`;
      params = [data.invoice_id];
    }

    const invRes = await pool.query(sql, params);
    const row = invRes.rows[0];
    if (row) {
      const seq = row.qb_ref_number || row.invoice_number;
      if (seq) {
        memo = `POS Invoice ${seq}`;
        invoiceMedusaRefNumber = `INV-${row.invoice_number}`;
      }
      if (row.shipping !== undefined && row.shipping !== null) {
        // pos_invoice.shipping is stored in cents — convert to dollars for QB
        invoiceShippingAmount = Number(row.shipping) / 100;
      }
      if (row.discount !== undefined && row.discount !== null) {
        // pos_invoice.discount is the invoice-level snapshot. For partial
        // invoices this is intentionally different from order.discount_total.
        invoiceDiscountAmount = Number(row.discount) / 100;
      }
    }
  } catch (e) {}

  let prebuiltItems: any[] | undefined;
  let salesTaxCode: string | undefined;

  // Always build explicit items + discount + shipping for the bridge.
  // Pre-1.5 the discount/shipping block was gated behind
  //   `if (!linkedTxnId || (linkedTxnId === qbSoTxnId && isPartial))`
  // which meant full SO→Invoice conversions silently lost the order-level
  // promotion + shipping line in QB. The SO handler is responsible for
  // baking these into the SO itself, but we cannot rely on QB auto-copy
  // when the POS invoice carries its own discount/shipping snapshot.
  const qbConfig = await getQbConfig();
  {
    const orderDiscountTotal =
      invoiceDiscountAmount !== undefined
        ? invoiceDiscountAmount
        : getEffectiveOrderDiscount(order);
    const isPartialAgainstSo = linkedTxnId === qbSoTxnId && isPartial;

    const activeItems = (order.items || [])
      .filter((item: any) => {
        const fi = fulfillmentItems.find((i: any) => {
          if (i.item_id && i.item_id === item.id) return true;
          if (i.id && i.id === item.id) return true;
          if (i.variant_id && i.variant_id === item.variant_id) return true;
          if (i.sku && item.variant?.sku && i.sku === item.variant.sku)
            return true;
          return false;
        });

        if (fi) {
          item.fulfillment_quantity = fi.quantity;
          item.fulfillment_unit_price = fi.unit_price;
          item.fulfillment_total = fi.total;
          return fi.quantity > 0;
        }

        if (isPartialAgainstSo) {
          return false;
        }
        return (item.quantity ?? 0) > 0;
      })
      .map((item: any) => ({
        ...item,
        quantity: item.fulfillment_quantity ?? item.quantity,
        unit_price:
          item.fulfillment_unit_price !== undefined
            ? getFloat(item.fulfillment_unit_price)
            : getFloat(item.unit_price),
        subtotal:
          item.fulfillment_total !== undefined
            ? getFloat(item.fulfillment_total)
            : item.subtotal !== undefined
              ? getFloat(item.subtotal)
              : undefined,
      }));

    const productTaxableMap = await resolveProductTaxableMap(
      _container.resolve("__pg_connection__"),
      activeItems
    );
    prebuiltItems = buildQbItems(activeItems, order.metadata, productTaxableMap);

    if (orderDiscountTotal > 0) {
      const orderSubtotal = getFloat(order.subtotal);
      const discountPercent =
        orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null;
      buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(
        (l) => prebuiltItems!.push(l)
      );
      logger.info(
        `${LOG_PREFIX} Discount lines added to invoice: -$${orderDiscountTotal.toFixed(2)}`
      );
    }

    let shippingMethodsFormatted = ((order as any).shipping_methods || []).map(
      (sm: any) => ({
        ...sm,
        amount: getFloat(sm.amount),
      })
    );

    if (invoiceShippingAmount !== undefined) {
      if (shippingMethodsFormatted.length > 0) {
        shippingMethodsFormatted[0].amount = invoiceShippingAmount;
        shippingMethodsFormatted = [shippingMethodsFormatted[0]];
      } else if (invoiceShippingAmount > 0) {
        shippingMethodsFormatted = [
          {
            name: "Shipping",
            amount: invoiceShippingAmount,
          },
        ];
      } else {
        shippingMethodsFormatted = [];
      }
    }

    const shippingItem = buildShippingQbItem(
      shippingMethodsFormatted,
      qbConfig.shippingItemId
    );
    if (shippingItem) {
      prebuiltItems.push(shippingItem);
      logger.info(
        `${LOG_PREFIX} Shipping line added for invoice: $${shippingItem.price?.toFixed(2)}`
      );
    }

    if (isPartialAgainstSo) {
      const {
        getSalesOrderDetailsFromQb,
      } = require("../../quickbooks/qb-bridge-client");
      const soDetails = await getSalesOrderDetailsFromQb(linkedTxnId);

      if (soDetails.success && soDetails.linesByProductId) {
        logger.info(
          `[QB-DEBUG] linesByProductId: ${JSON.stringify(soDetails.linesByProductId)}`
        );
        logger.info(
          `[QB-DEBUG] prebuiltItems: ${JSON.stringify(prebuiltItems)}`
        );
        prebuiltItems.forEach((item: any) => {
          const pid = item.productId;
          if (pid && soDetails.linesByProductId![pid]) {
            item.LinkToTxnLineID = soDetails.linesByProductId![pid];
          }
        });
        logger.info(
          `${LOG_PREFIX} Successfully mapped ${prebuiltItems.filter((i) => i.LinkToTxnLineID).length} TxnLineIDs for Partial Invoice!`
        );
      } else {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Failed to fetch SO details for Partial Invoice TxnLineIDs: ${soDetails.error}`
        );
      }
    }

    const hasTax = getFloat(order.tax_total) > 0;
    salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : qbConfig.exemptSalesTaxCode;
  }

  // Inject pre-flight metadata so UI shows "CREATING..."
  try {
    await orderModule.updateOrders(orderId, {
      metadata: { ...(order.metadata || {}), qb_sync_status: "creating" },
    });
  } catch (mErr) {
    logger.warn(`${LOG_PREFIX} Could not set creating status: ${mErr}`);
  }

  // Skip the Sales Order pipeline row — an Invoice supersedes the need for a separate SO.
  try {
    await skipSalesOrderPipelineRow(orderId);
  } catch (skipErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not skip SO pipeline row: ${skipErr.message}`
    );
  }

  // Write "pending" pipeline row immediately so it appears in the UI before polling starts
  try {
    await writePipelineRow({
      orderId,
      referenceId: invoiceReferenceId,
      referenceType: invoiceReferenceType,
      step: "invoice",
      status: "pending",
      medusaRefNumber: invoiceMedusaRefNumber,
    });
  } catch (pErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  // Resolve the QB SalesTaxItem ListID. When the order is exempt
  // (tax_total === 0) we emit the env-configured Exempt ListID so QB
  // stamps the header tax code as Exempt and skips tax math even though
  // per-line items remain marked taxable. Falls back to the persisted
  // metadata.qb_tax_item_listid (legacy) when present and the order is
  // taxable; otherwise to the taxed ListID from env.
  const hasTaxForListid = getFloat(order.tax_total) > 0;
  const persistedTaxListid = order.metadata?.qb_tax_item_listid as
    | string
    | undefined;
  const qbTaxItemListid = hasTaxForListid
    ? persistedTaxListid ?? resolveTaxListid("florida", qbConfig) ?? undefined
    : resolveTaxListid("exempt", qbConfig) ?? undefined;

  const result = await processInvoiceInQb({
    orderId,
    orderDisplayId: order.display_id,
    qbCustomerId,
    qbSoTxnId: linkedTxnId,
    qbPaymentTxnId,
    paymentAmount: getFloat(fulfillmentAmount),
    prebuiltItems,
    salesTaxCode,
    qbTaxItemListid,
    salesRep: parseSalesRepInitials(order.metadata?.sales_rep),
    memo,
    onSubmitted: async (operationId) => {
      await writePipelineRow({
        orderId,
        referenceId: invoiceReferenceId,
        referenceType: invoiceReferenceType,
        step: "invoice",
        status: "submitted",
        bridgeOpId: operationId,
        medusaRefNumber: invoiceMedusaRefNumber,
      });
    },
  });

  if (result.skipped) {
    logger.info(`${LOG_PREFIX} ⏭️ Invoice skipped (QB disabled)`);
    return;
  }
  if (result.error) {
    logger.error(`${LOG_PREFIX} ❌ processInvoiceInQb error: ${result.error}`);
    try {
      await orderModule.updateOrders(orderId, {
        metadata: { ...(order.metadata || {}), qb_sync_status: "error" },
      });
    } catch (mErr) {}
    try {
      await writePipelineRow({
        orderId,
        referenceId: invoiceReferenceId,
        referenceType: invoiceReferenceType,
        step: "invoice",
        status: "failed",
        error: result.error,
        medusaRefNumber: invoiceMedusaRefNumber,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
      );
    }
    return;
  }

  if (result.txnId || result.operationId) {
    // Record in pipeline
    try {
      await writePipelineRow({
        orderId,
        referenceId: invoiceReferenceId,
        referenceType: invoiceReferenceType,
        step: "invoice",
        status: result.operationId && !result.txnId ? "submitted" : "confirmed",
        bridgeOpId: result.operationId || null,
        qbTxnId: result.txnId || null,
        qbRefNumber: result.refNumber || null,
        medusaRefNumber: invoiceMedusaRefNumber,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
      );
    }

    if (result.editSequence && result.txnId) {
      try {
        await cacheEditSequence("invoice", result.txnId, result.editSequence);
        logger.info(
          `${LOG_PREFIX} ✅ Cached EditSequence for Invoice TxnID=${result.txnId}`
        );
      } catch (cacheErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not cache EditSequence: ${cacheErr.message}`
        );
      }
    }

    try {
      const fulfillmentId: string | null =
        (data.fulfillment_id as string | undefined) ?? null;
      const invoiceId: string | null =
        (data.invoice_id as string | undefined) ?? null;
      const patch = buildInvoicePatch(order.metadata || {}, {
        txnId: result.txnId || null,
        refNumber: result.refNumber || null,
        operationId: result.operationId || null,
        fulfillmentId,
        invoiceId,
        syncStatus: "child_synced",
      });
      // If no Sales Order was involved (standalone invoice), mark qb_so_txn_id with
      // a sentinel so the cron knows not to create a duplicate Sales Order for this order.
      const extraMeta = !qbSoTxnId ? { qb_so_txn_id: "SKIPPED_INVOICED" } : {};
      await orderModule.updateOrders(orderId, {
        metadata: { ...patch, ...extraMeta },
      });

      // Feature Upgrade: Store QB data natively onto the invoice (and fulfillment if immediate delivery)
      if (invoiceId) {
        let invoiceService: any;
        try {
          invoiceService = _container.resolve("invoices");
        } catch (e) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Invoice module not registered, skipped saving QB TxnID to invoice metadata.`
          );
        }

        if (invoiceService) {
          try {
            const inv = await invoiceService.retrievePosInvoice(invoiceId);
            const existingInvMeta = inv.metadata || {};
            await invoiceService.updatePosInvoices({
              id: invoiceId,
              metadata: {
                ...existingInvMeta,
                qb_txn_id: result.txnId || null,
                qb_ref_number: result.refNumber || null,
                qb_operation_id: result.operationId || null,
              },
            });
            logger.info(
              `${LOG_PREFIX} ✅ Saved native QB Meta to POS Invoice ${invoiceId}`
            );
          } catch (metaErr: any) {
            logger.warn(
              `${LOG_PREFIX} Failed to save native QB Meta to POS Invoice ${invoiceId}: ${metaErr.message}`
            );
          }
        }
      }

      if (fulfillmentId) {
        try {
          const fulfillmentModule = _container.resolve("fulfillment");
          const ful =
            await fulfillmentModule.retrieveFulfillment(fulfillmentId);
          const existingFulMeta = ful.metadata || {};
          await fulfillmentModule.updateFulfillment(fulfillmentId, {
            metadata: {
              ...existingFulMeta,
              qb_txn_id: result.txnId || null,
              qb_ref_number: result.refNumber || null,
            },
          });
          logger.info(
            `${LOG_PREFIX} ✅ Saved native QB Meta to Fulfillment ${fulfillmentId}`
          );
        } catch (fulErr: any) {
          logger.warn(
            `${LOG_PREFIX} Failed to save native QB Meta to Fulfillment ${fulfillmentId}: ${fulErr.message}`
          );
        }
      }
      logger.info(
        `${LOG_PREFIX} ✅ Saved invoice metadata — TxnID=${result.txnId}, Ref=${result.refNumber}, ful=${fulfillmentId}`
      );
    } catch (metaErr: any) {
      logger.error(
        `${LOG_PREFIX} ⚠️ Failed to save invoice metadata: ${metaErr.message}`
      );
    }
  }
}
