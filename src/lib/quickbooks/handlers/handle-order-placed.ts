import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  processOrderInQb,
  buildQbItems,
  resolveProductTaxableMap,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
  getEffectiveOrderDiscount,
} from "../order-flow-core";
import { enqueueVoidIfAlreadyVoided } from "../pipeline/void-intent";
import { parseSalesRepInitials } from "../parse-sales-rep";
import {
  getEstimateTxnId,
  getSoTxnId,
  getSoOperationId,
} from "../qb-metadata-types";
import {
  coalesceIfInFlight,
  writePipelineRow,
  cacheEditSequence,
  requireQbCustomer,
} from "../qb-pipeline";

import { LOG_PREFIX, getQbConfig, isPosOrder, processingOrders } from "./utils";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";
import { resolveTaxListid } from "../resolve-tax-listid";

async function mergeOrderMetadata(
  orderId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || $1::jsonb WHERE id = $2`,
    [JSON.stringify(patch), orderId]
  );
}

export async function handleOrderPlaced(
  data: any,
  _orderModule: any,
  customerModule: any,
  _container: any,
  logger: any,
  isCron: boolean = false
) {
  const orderId = data.id;
  logger.info(`${LOG_PREFIX} ── order.placed → ${orderId} ──`);

  // Coalesce rapid saves: if a sales_order op is already in-flight, mark next_payload
  // and return — consolidator will re-submit after current op confirms.
  if (!isCron) {
    const coalesced = await coalesceIfInFlight(orderId, null, "sales_order");
    if (coalesced) {
      logger.info(
        `${LOG_PREFIX} ⏸ Sales order in-flight for ${orderId} — coalesced as next submit`
      );
      return;
    }
  }

  // Read QB config (shipping item ID + sales tax code)
  const qbConfig = await getQbConfig();

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

    if (!fetchedOrder) {
      throw new Error(`Query returned no order for id ${orderId}`);
    }
    order = fetchedOrder;
    logger.info(
      `${LOG_PREFIX} Order fetched via Query: #${order.display_id}, items=${order.items?.length ?? 0}, shipping_methods=${order.shipping_methods?.length ?? 0}, sales_channel_id=${order.sales_channel_id ?? "none"}`
    );

    // Resolve the QB customer for this order (live customer wins; a stale
    // order-metadata cache is re-stamped). This is critical context needed by
    // every subsequent QB operation (SO, invoice, SR, payment). We do this
    // unconditionally — before any 1h-delay / qb_skip branching — so it
    // happens even for orders that never generate a Sales Order in QB.
    {
      const resolvedListId = await resolveOrderQbCustomer({
        orderId,
        cachedListId:
          (order.metadata?.qb_list_id as string | undefined) ?? null,
        liveListId:
          (order.customer?.metadata?.qb_list_id as string | undefined) ?? null,
        logger,
      });
      if (resolvedListId) {
        order.metadata = {
          ...(order.metadata || {}),
          qb_list_id: resolvedListId,
        };
      }
    }

    if (
      order.metadata?.qb_skip === true ||
      order.metadata?.qb_skip === "true"
    ) {
      logger.info(
        `${LOG_PREFIX} ⏭️ qb_skip=true — QB sync skipped (manual entry)`
      );
      const docNum =
        (order.metadata?.document_number as string | undefined) ||
        (order.display_id ? `S${order.display_id}` : null);
      try {
        await writePipelineRow({
          orderId,
          step: "sales_order",
          status: "manual",
          medusaRefNumber: docNum,
        });
      } catch (pErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not write manual pipeline row: ${pErr.message}`
        );
      }
      return;
    }

    if (!isCron && isPosOrder(order)) {
      logger.info(
        `${LOG_PREFIX} ⏭️ POS order (channel: ${order.sales_channel_id}) — Sales Order creation delayed by 1 hour (handled by cron), skipping immediate sync`
      );
      const soFriendlyRef =
        (order.metadata?.document_number as string | undefined) ||
        (order.display_id ? `#${order.display_id}` : null);
      try {
        await writePipelineRow({
          orderId,
          step: "sales_order",
          status: "waiting",
          medusaRefNumber: soFriendlyRef,
        });
      } catch (pErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not write waiting pipeline row: ${pErr.message}`
        );
      }
      return;
    }

    if (order.items && order.items[0]) {
      logger.info(
        `${LOG_PREFIX} DEBUG: First item variant: ${JSON.stringify(order.items[0].variant)}`
      );
    }
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId} via Query: ${err.message}`
    );
    return;
  }

  logger.info(
    `${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`
  );

  if (processingOrders.has(orderId)) {
    logger.info(
      `${LOG_PREFIX} ⏭️ Already processing ${orderId} in this process — skipping duplicate`
    );
    return;
  }
  processingOrders.add(orderId);

  try {
    const existingSoTxnId = getSoTxnId(order.metadata);
    if (existingSoTxnId) {
      logger.info(
        `${LOG_PREFIX} ⏭️ QB SO already exists (txnId=${existingSoTxnId}) — skipping duplicate`
      );
      return;
    }
    const existingSoOpId = getSoOperationId(order.metadata);
    if (existingSoOpId) {
      logger.info(
        `${LOG_PREFIX} ⏭️ QB SO already queued (opId=${existingSoOpId}) — skipping duplicate`
      );
      return;
    }

    const estimateTxnId = getEstimateTxnId(order.metadata);
    if (estimateTxnId) {
      logger.info(
        `${LOG_PREFIX} ✅ Order has qb_estimate_txn_id=${estimateTxnId} — will convert Estimate→SO`
      );
    } else {
      logger.info(
        `${LOG_PREFIX} ℹ️ No qb_estimate_txn_id — direct order path (will check customer)`
      );
    }

    let customer = (order as any).customer ?? null;
    if (!customer && order.customer_id) {
      try {
        customer = await customerModule.retrieveCustomer(order.customer_id, {
          relations: ["addresses"],
        });
        logger.info(
          `${LOG_PREFIX} Customer fetched separately: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`
        );
      } catch (custErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not fetch customer ${order.customer_id}: ${custErr.message}`
        );
      }
    } else if (customer) {
      logger.info(
        `${LOG_PREFIX} Customer embedded: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`
      );
    } else {
      logger.warn(`${LOG_PREFIX} ⚠️ Order ${orderId} has no customer_id`);
    }

    // Preflight: if customer has no qb_list_id, enqueue a customer pipeline row,
    // mark this SO row as waiting with depends_on, and return early. The
    // consolidator will create the customer and wake this row automatically.
    if (
      order.customer_id &&
      !order.metadata?.qb_list_id &&
      !customer?.metadata?.qb_list_id
    ) {
      const check = await requireQbCustomer({
        customerId: order.customer_id,
        orderId,
        step: "sales_order",
        selfMedusaRefNumber:
          (order.metadata?.document_number as string | undefined) ||
          (order.display_id ? `S${order.display_id}` : null),
      });
      if ("waiting" in check) {
        logger.info(
          `${LOG_PREFIX} ⏸ Waiting on customer ${order.customer_id} (customer row ${check.customerRowId}) before submitting SO`
        );
        return;
      }
    }

    const orderDiscountTotal = getEffectiveOrderDiscount(order);

    const activeItems = (order.items || [])
      .filter((item: any) => (item.quantity ?? 0) > 0)
      .map((item: any) => ({
        ...item,
        unit_price: Number(item.unit_price || 0),
        subtotal: undefined,
      }));

    const productTaxableMap = await resolveProductTaxableMap(
      _container.resolve("__pg_connection__"),
      activeItems
    );
    const qbItems = buildQbItems(activeItems, order.metadata, productTaxableMap);

    if (orderDiscountTotal > 0) {
      const orderSubtotal = Number(order.subtotal || 0);
      const discountPercent =
        orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null;
      buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(
        (l) => qbItems.push(l)
      );
      logger.info(
        `${LOG_PREFIX} Discount lines added: -$${orderDiscountTotal.toFixed(2)}`
      );
    }

    const shippingItem = buildShippingQbItem(
      (order as any).shipping_methods || [],
      qbConfig.shippingItemId
    );
    if (shippingItem) {
      qbItems.push(shippingItem);
      logger.info(
        `${LOG_PREFIX} Shipping line added: $${shippingItem.price?.toFixed(2)} (${shippingItem.desc})`
      );
    } else {
      logger.info(`${LOG_PREFIX} No shipping line (pickup or $0)`);
    }

    const hasTax = order.tax_total && order.tax_total > 0;
    const salesTaxCode = hasTax
      ? qbConfig.defaultSalesTaxCode
      : qbConfig.exemptSalesTaxCode;
    // Resolve the QB SalesTaxItem ListID. When the order is exempt
    // (tax_total === 0) we always emit the env-configured Exempt ListID so
    // QB stamps the header tax code as Exempt and skips tax math even
    // though per-line items remain marked taxable. Falls back to the
    // persisted metadata.qb_tax_item_listid (legacy) when present and the
    // order is taxable; otherwise to the taxed ListID from env.
    const persistedTaxListid = order.metadata?.qb_tax_item_listid as
      | string
      | undefined;
    const qbTaxItemListid = hasTax
      ? persistedTaxListid ?? resolveTaxListid("florida", qbConfig) ?? undefined
      : resolveTaxListid("exempt", qbConfig) ?? undefined;
    logger.info(
      `${LOG_PREFIX} tax_total=${order.tax_total} → salesTaxCode=${salesTaxCode ?? "Exempt (none passed)"} qbTaxItemListid=${qbTaxItemListid ?? "(none, fallback to FullName)"}`
    );

    const orderWithCustomer = { ...order, customer, items: activeItems };

    // Inject pre-flight metadata so UI shows "CREATING..."
    try {
      await mergeOrderMetadata(orderId, { qb_sync_status: "creating" });
    } catch (mErr) {
      logger.warn(`${LOG_PREFIX} Could not set creating status: ${mErr}`);
    }

    // Re-read document_number fresh from DB — the document-number subscriber may have
    // written it after our initial order fetch (concurrent event handlers).
    // Do this BEFORE writing the pipeline row so medusaRefNumber is also correct.
    const orderPrefix = isPosOrder(order) ? "POS Order" : "Web Order";
    let freshDocNum: string | undefined;
    try {
      const pool = getDbPool();
      const { rows } = await pool.query(
        `SELECT metadata->>'document_number' AS document_number FROM "order" WHERE id = $1`,
        [orderId]
      );
      freshDocNum = rows[0]?.document_number as string | undefined;
    } catch {
      freshDocNum = order.metadata?.document_number as string | undefined;
    }
    const soFriendlyRef =
      freshDocNum || (order.display_id ? `S${order.display_id}` : null);
    const soMemo = `${orderPrefix} ${freshDocNum || order.display_id || orderId}`;

    // Write "pending" pipeline row immediately so it appears in the UI before polling starts.
    try {
      await writePipelineRow({
        orderId,
        step: "sales_order",
        status: "pending",
        medusaRefNumber: soFriendlyRef,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
      );
    }

    const result = await processOrderInQb(orderWithCustomer, customerModule, {
      prebuiltItems: qbItems,
      salesTaxCode,
      qbTaxItemListid,
      memo: soMemo,
      salesRep: parseSalesRepInitials(order.metadata?.sales_rep),
      onSubmitted: async (operationId) => {
        await writePipelineRow({
          orderId: orderWithCustomer.id,
          step: "sales_order",
          status: "submitted",
          bridgeOpId: operationId,
        });
      },
    });

    if (result.skipped) {
      logger.info(`${LOG_PREFIX} ⏭️ Skipped: ${result.skipReason}`);
      return;
    }
    if (!result.enabled) {
      logger.info(`${LOG_PREFIX} ⏭️ QB disabled: ${result.skipReason}`);
      return;
    }
    if (result.error) {
      logger.error(`${LOG_PREFIX} ❌ processOrderInQb error: ${result.error}`);
      try {
        await mergeOrderMetadata(orderId, { qb_sync_status: "error" });
      } catch (mErr) {}
      return;
    }

    if (result.soTxnId || result.operationId) {
      try {
        const isAsync = !!result.operationId && !result.soTxnId;
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = {
          qb_sales_order: {
            txn_id: result.soTxnId ?? "",
            ref_number: result.soRefNumber ?? result.soTxnId ?? "",
            operation_id: result.operationId ?? null,
            edit_sequence: result.editSequence ?? null,
            synced_at: now,
          },
          qb_sync_status: isAsync ? "pending" : "synced",
          qb_synced_at: now,
          ...(result.customerId ? { qb_list_id: result.customerId } : {}),
        };
        await mergeOrderMetadata(orderId, patch);
        logger.info(
          `${LOG_PREFIX} ✅ Saved SO metadata — TxnID=${result.soTxnId}, Ref=${result.soRefNumber}, EditSeq=${result.editSequence ?? "none"}, OpID=${result.operationId}`
        );

        // Cache EditSequence for future Mod ops
        if (result.editSequence && result.soTxnId) {
          try {
            await cacheEditSequence(
              "sales_order",
              result.soTxnId,
              result.editSequence
            );
            logger.info(
              `${LOG_PREFIX} ✅ Cached EditSequence for SO TxnID=${result.soTxnId}`
            );
          } catch (cacheErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not cache EditSequence: ${cacheErr.message}`
            );
          }
        }
      } catch (metaErr: any) {
        logger.error(
          `${LOG_PREFIX} ⚠️ Failed to save order metadata: ${metaErr.message}`
        );
      }

      // Record in pipeline
      try {
        await writePipelineRow({
          orderId,
          step: "sales_order",
          status:
            result.operationId && !result.soTxnId ? "submitted" : "confirmed",
          bridgeOpId: result.operationId || null,
          qbTxnId: result.soTxnId || null,
          qbRefNumber: result.soRefNumber || null,
        });
      } catch (pErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
        );
      }

      // Camino INLINE de confirmación — ver pipeline/void-intent.ts. Cubre la
      // orden cancelada mientras su Sales Order todavía se estaba creando en QB.
      if (result.soTxnId) {
        await enqueueVoidIfAlreadyVoided({
          createStep: "sales_order",
          referenceId: null,
          orderId,
          qbTxnId: result.soTxnId,
          qbRefNumber: result.soRefNumber || null,
          medusaRefNumber: result.soRefNumber || null,
          logger,
        });
      }
    } else {
      logger.warn(
        `${LOG_PREFIX} ⚠️ No soTxnId or operationId returned — QB document may not have been created`
      );
      try {
        await mergeOrderMetadata(orderId, { qb_sync_status: "error" });
      } catch (mErr) {}

      // Record failure in pipeline
      try {
        await writePipelineRow({
          orderId,
          step: "sales_order",
          status: "failed",
          error: result.error || "No txnId or operationId returned from bridge",
        });
      } catch (pErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`
        );
      }
    }
  } finally {
    processingOrders.delete(orderId);
  }
}
