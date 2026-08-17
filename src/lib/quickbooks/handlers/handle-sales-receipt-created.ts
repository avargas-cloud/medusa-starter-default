import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  processSalesReceiptInQb,
  buildQbItems,
  resolveProductTaxableMap,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
  getEffectiveOrderDiscount,
} from "../order-flow-core";
import { enqueueVoidIfAlreadyVoided } from "../pipeline/void-intent";
import { parseSalesRepInitials } from "../parse-sales-rep";
import { resolveQbPaymentMethodForPayment } from "../payment-method-sanitizer";
import {
  buildInvoicePatch,
  getSoTxnId,
  getEstimateTxnId,
} from "../qb-metadata-types";
import { bridgeFetch } from "../client/core";
import {
  coalesceIfInFlight,
  writePipelineRow,
  cacheEditSequence,
  skipSalesOrderPipelineRow,
  requireQbCustomer,
} from "../qb-pipeline";

import { handleFulfillmentCreated } from "./handle-fulfillment-created";
import { LOG_PREFIX, getQbConfig, getFloat, consumeClosestNet } from "./utils";
import { resolveOrderQbCustomer } from "../resolve-order-qb-customer";
import { resolveTaxListid } from "../resolve-tax-listid";
import { invoiceLineDiscountCents } from "../force-sync-doc-payload";

export async function handleSalesReceiptCreated(
  data: any,
  orderModule: any,
  customerModule: any,
  _container: any,
  logger: any,
  /**
   * `preclaimedRowId`: la fila de pipeline que el dispatcher del consolidator
   * YA puso en `processing` antes de invocar este handler. Sin ella, el claim
   * de más abajo choca contra el índice de filas vivas y este handler se
   * detecta a sí mismo como ADD en vuelo — el deadlock que dejó al 100% de las
   * ventas del 2026-08-17 fuera de QuickBooks. Sólo la pasa `resubmit-by-step`;
   * el camino por evento sigue reclamando su propia fila.
   */
  opts?: { preclaimedRowId?: string | null }
) {
  const orderId = data.order_id || data.id;
  logger.info(
    `${LOG_PREFIX} ── pos.sales_receipt.created → orderId=${orderId} ──`
  );
  logger.info(
    `${LOG_PREFIX} Sales Receipt event data: ${JSON.stringify(data)}`
  );

  // Coalesce rapid saves: if a sales_receipt op is already in-flight, mark next_payload
  // and return — consolidator will re-submit after current op confirms.
  const coalescedSR = await coalesceIfInFlight(orderId, null, "sales_receipt");
  if (coalescedSR) {
    logger.info(
      `${LOG_PREFIX} ⏸ Sales receipt in-flight for ${orderId} — coalesced as next submit`
    );
    return;
  }

  // Secondary guard: detect recently-failed SR rows that still have a bridge op
  // pending. coalesceIfInFlight only sees 'submitted' rows; a row can be marked
  // 'failed' by the stale-cleanup pass while its bridge op is still processing.
  // Submitting a new SR in that window creates a duplicate document in QB.
  {
    const pool = getDbPool();
    const { rows: failedWithOp } = await pool.query(
      `SELECT id, bridge_op_id FROM qb_order_pipeline
       WHERE order_id = $1 AND step = 'sales_receipt'
         AND status = 'failed' AND bridge_op_id IS NOT NULL
         AND failed_at > NOW() - INTERVAL '2 hours'
       ORDER BY failed_at DESC LIMIT 1`,
      [orderId]
    );
    if (failedWithOp.length > 0) {
      const { id: failedRowId, bridge_op_id: oldOpId } = failedWithOp[0] as {
        id: string;
        bridge_op_id: string;
      };
      try {
        const statusRes = await bridgeFetch(
          "GET",
          `/api/sync/status/${oldOpId}`
        );
        const opStatus = statusRes?.operation?.status as string | undefined;
        if (opStatus === "pending" || opStatus === "processing") {
          // The original bridge op is still running — restore the row to
          // 'submitted' so the consolidator picks it up, and skip this retry.
          await pool.query(
            `UPDATE qb_order_pipeline
             SET status = 'submitted', failed_at = NULL, error = NULL, updated_at = NOW()
             WHERE id = $1`,
            [failedRowId]
          );
          logger.info(
            `${LOG_PREFIX} ⏸ Bridge op ${oldOpId} still ${opStatus} — restored row ${failedRowId} to submitted, skipping duplicate SR`
          );
          return;
        }
      } catch (bridgeCheckErr: any) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not check bridge op ${oldOpId}: ${bridgeCheckErr.message} — proceeding with SR creation`
        );
      }
    }
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
      `${LOG_PREFIX} Order fetched for Sales Receipt: #${order.display_id}, customer_id=${order.customer_id}`
    );
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`
    );
    return;
  }

  // Live customer wins over the order-metadata cache (re-stamped on drift).
  let qbCustomerId: string | undefined = await resolveOrderQbCustomer({
    orderId,
    cachedListId: (order.metadata?.qb_list_id as string | undefined) ?? null,
    liveListId:
      (order.customer?.metadata?.qb_list_id as string | undefined) ?? null,
    logger,
  });

  if (!qbCustomerId && order.customer_id) {
    const check = await requireQbCustomer({
      customerId: order.customer_id,
      orderId,
      step: "sales_receipt",
      selfReferenceId: data.invoice_id || null,
      selfReferenceType: data.invoice_id ? "pos_invoice" : null,
    });
    if ("waiting" in check) {
      logger.info(
        `${LOG_PREFIX} ⏸ Waiting on customer ${order.customer_id} (customer row ${check.customerRowId}) before submitting SR`
      );
      return;
    }
    qbCustomerId = check.qbListId;
  }

  if (!qbCustomerId) {
    const errMsg = `Missing customer_id on order ${orderId} — cannot create Sales Receipt.`;
    logger.warn(`${LOG_PREFIX} ❌ ${errMsg}`);
    try {
      await writePipelineRow({
        orderId,
        referenceId: data.invoice_id || null,
        referenceType: data.invoice_id ? "pos_invoice" : null,
        step: "sales_receipt",
        status: "failed",
        error: errMsg,
      });
    } catch (pErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write failed pipeline row: ${pErr.message}`
      );
    }
    return;
  }

  // ── Sales Receipt Qualification Guard ────────────────────────────────────
  // A Sales Receipt is only valid if NO QB Sales Order or Estimate already
  // exists for this order. If the 1-hour POS cron ran first and created a
  // Sales Order (or Estimate), we must fall back to a regular Invoice so we
  // don't create a duplicate/conflicting document in QB Desktop.
  const existingSoTxnId = getSoTxnId(order.metadata);
  const existingEstimateTxnId = getEstimateTxnId(order.metadata);

  const hasRealSo =
    existingSoTxnId && existingSoTxnId !== "SKIPPED_SALES_RECEIPT";
  const hasRealEstimate = !!existingEstimateTxnId;

  if (hasRealSo || hasRealEstimate) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Order already has a QB document ` +
        `(SO=${existingSoTxnId ?? "none"}, Estimate=${existingEstimateTxnId ?? "none"}). ` +
        `Cannot create Sales Receipt — marking SR failed and falling back to Invoice.`
    );
    // Explicitly fail the SR pipeline row so it doesn't stay stuck in 'pending'.
    try {
      await writePipelineRow({
        orderId,
        referenceId: data.invoice_id || null,
        referenceType: data.invoice_id ? "pos_invoice" : null,
        step: "sales_receipt",
        status: "failed",
        error: `SR superseded by existing QB document (SO=${existingSoTxnId ?? "none"}, Estimate=${existingEstimateTxnId ?? "none"}) — Invoice created instead`,
      });
    } catch (srFailErr: any) {
      logger.warn(`${LOG_PREFIX} ⚠️ Could not mark SR row as failed: ${srFailErr.message}`);
    }
    await handleFulfillmentCreated(
      data,
      orderModule,
      customerModule,
      _container,
      logger
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  let fulfillmentItems: any[] =
    data.items && Array.isArray(data.items) ? data.items : [];

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

  const pool = getDbPool();
  let memo: string | undefined;
  let invoiceShippingAmount: number | undefined;
  let invoiceDiscountAmount: number | undefined;
  let invoicePaymentMethod: string | undefined;
  let invoiceCardBrand: string | undefined;
  // Source date for the QB Sales Receipt <TxnDate>. Captured from pos_invoice
  // (cashier close moment) so QB books on day-0 even if the bridge retries
  // the next day.
  let receiptDate: string | Date | null = null;

  try {
    // Fallback for invoice_id when called by the consolidator (which only passes order_id)
    let sql = `SELECT id, invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount, payment_method, card_brand, created_at, issued_at FROM pos_invoice WHERE fulfillment_id = $1 LIMIT 1`;
    let params: any[] = [data.fulfillment_id];

    if (data.invoice_id) {
      sql = `SELECT id, invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount, payment_method, card_brand, created_at, issued_at FROM pos_invoice WHERE id = $1 LIMIT 1`;
      params = [data.invoice_id];
    } else if (!data.fulfillment_id && orderId) {
      // Cron resubmit path — only order_id available
      sql = `SELECT id, invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount, payment_method, card_brand, created_at, issued_at FROM pos_invoice WHERE order_id = $1 ORDER BY issued_at DESC LIMIT 1`;
      params = [orderId];
    }

    const invRes = await pool.query(sql, params);
    const row = invRes.rows[0];
    if (row) {
      if (row.invoice_number) {
        memo = `POS Invoice ${row.invoice_number}`;
      }
      if (row.shipping !== undefined && row.shipping !== null) {
        // pos_invoice.shipping is stored in cents — convert to dollars for QB
        invoiceShippingAmount = Number(row.shipping) / 100;
      }
      if (row.discount !== undefined && row.discount !== null) {
        // pos_invoice.discount is the invoice-level snapshot in cents
        invoiceDiscountAmount = Number(row.discount) / 100;
      }
      if (row.payment_method) {
        invoicePaymentMethod = String(row.payment_method);
      }
      if (row.card_brand) {
        invoiceCardBrand = String(row.card_brand);
      }
      // Hydrate invoice_id for downstream pipeline writes when consolidator
      // only passed order_id.
      if (!data.invoice_id && row.id) {
        data.invoice_id = row.id;
      }
      receiptDate = row.issued_at ?? row.created_at ?? null;
    }
  } catch (e) {}

  // Final fallback: the order itself. Keeps QB <TxnDate> stable even if the
  // pos_invoice lookup failed. Never falls through to "now".
  if (!receiptDate) {
    receiptDate = order.created_at ?? null;
  }

  let prebuiltItems: any[] | undefined;
  let salesTaxCode: string | undefined;
  const qbConfig = await getQbConfig();

  // ── Per-line discount baking + taxable snapshot (mirrors Invoice handler) ──
  // Load frozen net_total_cents and taxable from pos_invoice_item so:
  //   (a) per-line POS discounts are baked into QB unit prices (G2 fix), and
  //   (b) taxable reflects the value at invoice creation, not the current
  //       catalog state (G1 fix — column auto-set by DB trigger at INSERT).
  let lineDiscountTotalCents = 0;
  // Multiset of frozen nets per `${variant|sku}|${grossCents}` key, CONSUMED per line
  // below. Two lines of the same variant at the same list price but different per-line
  // discount collapse to one key; a scalar map let the second overwrite the first so both
  // read the discounted net (order 2450 dup-SKU bug). Parity with handle-fulfillment-created.
  const netByLine = new Map<string, number[]>();
  const snapshotTaxableByVariantId = new Map<string, boolean>();

  if (data.invoice_id) {
    try {
      const netPool = getDbPool();
      const { rows: netRows } = await netPool.query(
        `SELECT variant_id, sku, total, net_total_cents, taxable
           FROM pos_invoice_item
          WHERE invoice_id = $1 AND deleted_at IS NULL AND net_total_cents IS NOT NULL`,
        [data.invoice_id]
      );
      for (const r of netRows) {
        const grossCents = Math.round(Number(r.total || 0));
        const key = `${r.variant_id ?? r.sku ?? "custom"}|${grossCents}`;
        const bucket = netByLine.get(key) ?? [];
        bucket.push(Number(r.net_total_cents));
        netByLine.set(key, bucket);
        if (r.variant_id != null && r.taxable != null) {
          snapshotTaxableByVariantId.set(
            String(r.variant_id),
            r.taxable === true || r.taxable === "true" || r.taxable === 1
          );
        }
      }
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} net_total_cents/taxable lookup failed (legacy recompute used): ${e.message}`
      );
    }
  }

  const activeItems = (order.items || [])
    .filter((item: any) => (item.quantity ?? 0) > 0)
    .map((item: any) => {
      const quantity = item.quantity;
      // item.unit_price is the NET (post per-item-discount) price; the GROSS
      // lives in metadata.original_unit_price. Treating the net as gross and
      // re-applying line_discount below double-discounts the line (e.g. 42.53
      // → 38.28) and leaves a rounding residue that spawns a phantom
      // "Order Discount" line. Mirror handle-fulfillment-created.ts (the
      // Invoice path) which already resolves gross from original_unit_price.
      // Guard on > 0 (not ??) so a present-but-invalid original_unit_price
      // ("" / 0) falls back to unit_price instead of zeroing the line. Legacy
      // lines (no original_unit_price) stored a gross unit_price, so the
      // fallback stays correct for them.
      const originalGrossUnitPrice = getFloat(item.metadata?.original_unit_price);
      const grossUnitPrice =
        originalGrossUnitPrice > 0
          ? originalGrossUnitPrice
          : getFloat(item.unit_price);
      const grossTotalCents = Math.round(grossUnitPrice * quantity * 100);

      const lineDiscount = item.metadata?.line_discount as
        | { type?: string | null; value?: number | string | null }
        | null
        | undefined;
      const lineDiscountCentsComputed = invoiceLineDiscountCents(
        {
          discount_type: lineDiscount?.type ?? null,
          discount_value: lineDiscount?.value ?? null,
          quantity,
        },
        null,
        grossTotalCents
      );

      const netKey = `${item.variant_id ?? item.variant?.sku ?? "custom"}|${grossTotalCents}`;
      // Consume the closest stored net from the bucket (see helper): keeps
      // same-variant/same-gross lines with different discounts distinct (order 2450).
      const storedNet = consumeClosestNet(
        netByLine.get(netKey),
        Math.max(0, grossTotalCents - lineDiscountCentsComputed)
      );
      const hasStoredNet = storedNet != null && Number.isFinite(storedNet);
      const lineDiscountCents = hasStoredNet
        ? Math.max(0, grossTotalCents - Math.max(0, storedNet as number))
        : lineDiscountCentsComputed;
      lineDiscountTotalCents += lineDiscountCents;

      if (lineDiscountCents > 0) {
        return {
          ...item,
          quantity,
          unit_price: grossUnitPrice,
          subtotal: Math.max(0, grossTotalCents - lineDiscountCents) / 100,
        };
      }
      return {
        ...item,
        quantity,
        unit_price: grossUnitPrice,
        subtotal: item.subtotal !== undefined ? getFloat(item.subtotal) : undefined,
      };
    });

  const productTaxableMap = await resolveProductTaxableMap(
    _container.resolve("__pg_connection__"),
    activeItems
  );
  // Override productTaxableMap entries with snapshot taxable values from
  // pos_invoice_item (written by DB trigger from product.taxable at insert time).
  // Takes precedence over the live catalog re-resolve so a product whose taxable
  // flag changed after the invoice was issued still arrives in QB correctly.
  for (const item of activeItems) {
    const variantId = item.variant_id ?? item.variant?.id;
    const productId =
      (item.variant as any)?.product_id ?? (item as any).product_id;
    if (variantId && productId && snapshotTaxableByVariantId.has(variantId)) {
      const snap = snapshotTaxableByVariantId.get(variantId)!;
      const existing = productTaxableMap[productId];
      productTaxableMap[productId] =
        typeof existing === "object" && existing !== null
          ? { ...existing, taxable: snap }
          : { taxable: snap };
    }
  }

  prebuiltItems = buildQbItems(activeItems, order.metadata, productTaxableMap);

  // Order-level discount ONLY. Strip per-line discounts already baked above so
  // the Discount line in QB is only the true order-level promotion (G3 fix).
  // Falls back to getEffectiveOrderDiscount for orders without a pos_invoice row.
  const orderDiscountTotal =
    invoiceDiscountAmount !== undefined
      ? Math.max(0, invoiceDiscountAmount - lineDiscountTotalCents / 100)
      : getEffectiveOrderDiscount(order);

  if (orderDiscountTotal > 0) {
    const orderSubtotal = getFloat(order.subtotal);
    const discountPercent =
      orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null;
    buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(
      (l) => prebuiltItems!.push(l)
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
  }

  const hasTax = getFloat(order.tax_total) > 0;
  salesTaxCode = hasTax
    ? qbConfig.defaultSalesTaxCode
    : qbConfig.exemptSalesTaxCode;
  // Resolve the QB SalesTaxItem ListID — exempt orders get the env-configured
  // Exempt ListID so QB skips tax math even though per-line items remain
  // marked taxable. Bridge prefers ListID over FullName.
  const persistedTaxListid = order.metadata?.qb_tax_item_listid as
    | string
    | undefined;
  const qbTaxItemListid = hasTax
    ? persistedTaxListid ?? resolveTaxListid("florida", qbConfig) ?? undefined
    : resolveTaxListid("exempt", qbConfig) ?? undefined;

  try {
    await orderModule.updateOrders(orderId, {
      metadata: { ...(order.metadata || {}), qb_sync_status: "creating" },
    });
  } catch (mErr) {
    logger.warn(`${LOG_PREFIX} Could not set creating status: ${mErr}`);
  }

  // Skip the Sales Order pipeline row — a Sales Receipt supersedes the need for a separate SO.
  try {
    await skipSalesOrderPipelineRow(orderId);
  } catch (skipErr: any) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not skip SO pipeline row: ${skipErr.message}`
    );
  }

  // No separate pre-flight "pending" write: processSalesReceiptInQb claims
  // the pipeline row itself (status 'processing') right before calling the
  // bridge — see pipeline/claim-sales-receipt.ts. A second, earlier write
  // here would collide with that claim's unique index the moment both are
  // live at once.

  // Resolve the QB PaymentMethod via the canonical split-aware helper:
  //   credit_card → send card_brand (Visa/MasterCard/Amex/Discover/Capital One)
  //   anything else → send payment_method (Debit Card / Cash / Check / ...)
  // Prefer the pos_invoice row (source of truth in DB); fall back to
  // data.payment_method only if the invoice row couldn't be read.
  const qbPaymentMethod = resolveQbPaymentMethodForPayment(
    invoicePaymentMethod ?? data.payment_method ?? null,
    invoiceCardBrand ?? null
  );
  if (!qbPaymentMethod) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ Could not resolve QB PaymentMethod for SR order ${orderId} ` +
        `from {payment_method=${invoicePaymentMethod ?? "∅"}, card_brand=${invoiceCardBrand ?? "∅"}, ` +
        `data.payment_method=${data.payment_method ?? "∅"}} — SR will have PaymentMethod blank`
    );
  }

  const result = await processSalesReceiptInQb({
    orderId,
    referenceId: data.invoice_id || orderId,
    orderDisplayId: order.display_id,
    qbCustomerId,
    paymentMethod: qbPaymentMethod,
    prebuiltItems,
    salesTaxCode,
    qbTaxItemListid,
    salesRep: parseSalesRepInitials(order.metadata?.sales_rep),
    memo,
    receiptDate,
    preclaimedRowId: opts?.preclaimedRowId ?? null,
  });

  if (result.skipped) {
    logger.info(
      `${LOG_PREFIX} ⏭️ Sales Receipt skipped (${result.skipReason || "QB disabled"})`
    );
    return;
  }
  if (result.error) {
    logger.error(
      `${LOG_PREFIX} ❌ processSalesReceiptInQb error: ${result.error}`
    );
    try {
      await orderModule.updateOrders(orderId, {
        metadata: { ...(order.metadata || {}), qb_sync_status: "error" },
      });
    } catch (mErr) {}
    // No pipeline write here: processSalesReceiptInQb already left the
    // claimed row 'failed' (releaseSalesReceiptClaim) or 'submitted' for an
    // ambiguous poll failure — see its comments for why the ambiguous case
    // deliberately does NOT release the claim.
    return;
  }

  if (result.txnId || result.operationId) {
    // processSalesReceiptInQb already wrote the pipeline row (claimed +
    // updated to submitted/confirmed) — nothing to record here.

    // Camino INLINE de confirmación — ver pipeline/void-intent.ts. Si el SR fue
    // voideado mientras su ADD estaba en vuelo, este es el primer momento en que
    // se conoce el TxnID y por lo tanto el único punto de reintento correcto.
    if (result.txnId) {
      await enqueueVoidIfAlreadyVoided({
        createStep: "sales_receipt",
        referenceId: data.invoice_id || null,
        orderId,
        qbTxnId: result.txnId,
        qbRefNumber: result.refNumber || null,
        medusaRefNumber: result.refNumber || null,
        logger,
      });
    }

    if (result.editSequence && result.txnId) {
      try {
        await cacheEditSequence(
          "sales_receipt",
          result.txnId,
          result.editSequence
        );
        logger.info(
          `${LOG_PREFIX} ✅ Cached EditSequence for Sales Receipt TxnID=${result.txnId}`
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

      // Critical Step: Pre-emptively write SKIPPED_SALES_RECEIPT so the cron doesn't create an SO
      const existingOrderMeta = order.metadata || {};
      const basePatch = buildInvoicePatch(existingOrderMeta, {
        txnId: result.txnId || null,
        refNumber: result.refNumber || null,
        operationId: result.operationId || null,
        fulfillmentId,
        invoiceId,
        syncStatus: "child_synced",
      });

      await orderModule.updateOrders(orderId, {
        metadata: {
          ...basePatch,
          qb_so_txn_id: "SKIPPED_SALES_RECEIPT",
        },
      });

      // Update local pos_invoice and fulfillment with native QB IDs (adding SR- prefix)
      if (invoiceId) {
        let invoiceService: any;
        try {
          invoiceService = _container.resolve("invoices");
        } catch (e) {}

        if (invoiceService) {
          try {
            const inv = await invoiceService.retrievePosInvoice(invoiceId);
            await invoiceService.updatePosInvoices({
              id: invoiceId,
              metadata: {
                ...(inv.metadata || {}),
                qb_txn_id: result.txnId || null,
                qb_ref_number: result.refNumber || null,
                qb_operation_id: result.operationId || null,
              },
            });
          } catch (metaErr: any) {}
        }

        let financeService: any;
        try {
          financeService = _container.resolve("finance");
        } catch (e) {}

        if (financeService) {
          try {
            // payment_id may be null for SR (invoice route intentionally omits it).
            // Fall back to looking up by any of: is_sales_receipt_payment flag (manual
            // SR flow), qb_source='sales_receipt' (terminal SR flow), or qb_sync_status
            // ='pending_sr' (tagged by invoice route on terminal-linked SR).
            // Never use a broad order_id fallback — it would incorrectly tag pre-existing
            // deposit payments (e.g. from BAMS payment link) as the Sales Receipt payment.
            let srPayment: any = null;
            if (data.payment_id) {
              srPayment = await financeService.retrieveCustomerPayment(
                data.payment_id
              );
            } else {
              const payments = await financeService
                .listCustomerPayments({
                  metadata: { order_id: orderId },
                })
                .catch(() => []);
              srPayment =
                (payments as any[]).find(
                  (p: any) =>
                    p.metadata?.is_sales_receipt_payment === true ||
                    p.metadata?.qb_source === "sales_receipt" ||
                    p.metadata?.qb_sync_status === "pending_sr"
                ) ?? null;
            }

            if (srPayment) {
              // Mark as Sales Receipt source — prevents ReceivePayment duplicate in QB
              // and blocks apply/unapply operations (SR payments are embedded, not standalone)
              await financeService.updateCustomerPayments({
                id: srPayment.id,
                metadata: {
                  ...(srPayment.metadata || {}),
                  qb_txn_id: result.txnId || null,
                  qb_ref_number: result.refNumber || null,
                  qb_operation_id: result.operationId || null,
                  qb_sync_status: "synced",
                  qb_source: "sales_receipt",
                },
                qb: {
                  status: "yes",
                  txn_id: result.txnId || null,
                  source: "sales_receipt",
                  edit_sequence: "No editable",
                },
              });
              logger.info(
                `${LOG_PREFIX} ✅ Tagged Payment ${srPayment.id} with SR ${result.refNumber} (source=sales_receipt)`
              );
            } else {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not find SR payment for order ${orderId} to tag`
              );
            }
          } catch (payErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Failed to tag Sales Receipt payment: ${payErr.message}`
            );
          }
        }
      }

      if (fulfillmentId) {
        try {
          const fulfillmentModule = _container.resolve("fulfillment");
          const ful =
            await fulfillmentModule.retrieveFulfillment(fulfillmentId);
          await fulfillmentModule.updateFulfillment(fulfillmentId, {
            metadata: {
              ...(ful.metadata || {}),
              qb_txn_id: result.txnId || null,
              qb_ref_number: result.refNumber || null,
            },
          });
        } catch (fulErr: any) {}
      }
      logger.info(
        `${LOG_PREFIX} ✅ Saved Sales Receipt metadata — TxnID=${result.txnId}, Ref=${result.refNumber}`
      );
    } catch (metaErr: any) {
      logger.error(
        `${LOG_PREFIX} ⚠️ Failed to save Sales Receipt metadata: ${metaErr.message}`
      );
    }
  }
}
