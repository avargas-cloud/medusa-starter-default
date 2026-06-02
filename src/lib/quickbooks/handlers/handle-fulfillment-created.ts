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
import { invoiceLineDiscountCents } from "../force-sync-doc-payload";
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
  // Source date for the QB <TxnDate>. Prefer the pos_invoice's issued_at /
  // created_at (when the cashier closed the sale or the invoice was generated)
  // so QB books on day-0 even if the bridge retries the next day.
  let invoiceDate: string | Date | null = null;

  try {
    let sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount, created_at, issued_at FROM pos_invoice WHERE fulfillment_id = $1 LIMIT 1`;
    let params: any[] = [data.fulfillment_id];

    if (data.invoice_id) {
      sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping, discount, created_at, issued_at FROM pos_invoice WHERE id = $1 LIMIT 1`;
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
      invoiceDate = row.issued_at ?? row.created_at ?? null;
    }
  } catch (e) {}

  // For non-POS fulfillments (no pos_invoice row), try the fulfillment's own
  // created_at — that's the moment the package was marked shipped.
  if (!invoiceDate && data.fulfillment_id) {
    try {
      const query = _container.resolve(ContainerRegistrationKeys.QUERY);
      const {
        data: [fulfillment],
      } = await query.graph({
        entity: "fulfillment",
        fields: ["created_at"],
        filters: { id: data.fulfillment_id },
      });
      if (fulfillment?.created_at) {
        invoiceDate = fulfillment.created_at;
      }
    } catch (e: any) {
      logger.warn(
        `${LOG_PREFIX} Could not fetch fulfillment.created_at for date: ${e.message}`
      );
    }
  }

  // Final fallback: the order itself. Keeps QB <TxnDate> stable even if the
  // pos_invoice/fulfillment lookups fail. Never falls through to "now".
  if (!invoiceDate) {
    invoiceDate = order.created_at ?? null;
  }

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
    const isPartialAgainstSo = linkedTxnId === qbSoTxnId && isPartial;

    // Item-level (per-line) discounts must be BAKED INTO the QB line prices,
    // NOT emitted as a separate order-level Discount line. The POS sends gross
    // unit prices in the snapshot (fulfillment_unit_price) plus a per-line
    // discount descriptor (metadata.line_discount); pos_invoice.discount lumps
    // every per-line discount together with any true order-level promotion.
    // Here we (a) net each line down by its own discount so buildQbItems emits
    // the discounted unit price, and (b) accumulate the per-line discount total
    // so we can subtract it from invoiceDiscountAmount below — leaving ONLY the
    // genuine order-level promotion (if any) for buildQbOrderDiscountLines.
    // Mirrors the force-sync path (src/api/admin/pos/sync/route.ts) which was
    // already correct. Without this, invoices showed full prices + a bogus
    // "Order Discount" equal to the summed item discounts (QB Inv 18791).
    let lineDiscountTotalCents = 0;

    // Frozen net (round-then-multiply) per line, loaded from the invoice snapshot.
    // Keyed by `${variant_id|sku}|${grossCents}` so same-variant lines at different
    // prices stay distinct (grossCents === pos_invoice_item.total). Populated only for
    // invoices issued after net_total_cents existed; legacy invoices yield an empty
    // map → the recompute below stays authoritative and the doc is untouched.
    const netByLine = new Map<string, number>();
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
          netByLine.set(key, Number(r.net_total_cents));
          if (r.variant_id != null && r.taxable != null) {
            snapshotTaxableByVariantId.set(
              String(r.variant_id),
              r.taxable === true || r.taxable === "true" || r.taxable === 1
            );
          }
        }
      } catch (e: any) {
        logger.warn(
          `${LOG_PREFIX} net_total_cents lookup failed (legacy recompute used): ${e.message}`
        );
      }
    }

    // Match each order line to a fulfillment line WITH CONSUMPTION so two
    // order lines that share a variant (the same SKU added twice at different
    // prices) cannot both claim the SAME fulfillment line. The previous
    // `fulfillmentItems.find(... item_id OR variant_id OR sku ...)` returned
    // the FIRST same-variant line for every order row: the loose variant_id
    // key matched before the precise per-line id was even compared on the next
    // candidate, so QB received duplicate identical lines (order 1970 / Inv
    // 20535 sent 3×$171.99 + 2×$139.99 both as 3×$171.99).
    //
    // Phase 1 globally claims every precise line-item-id match first, so a
    // later loose match can't steal a line that another order row matches
    // exactly. Phase 2 fills the remaining rows by variant/sku, consuming each
    // fulfillment line once.
    const claimedFulfillmentIdx = new Set<number>();
    const preciseFiByOrderItemId = new Map<string, any>();
    for (const item of order.items || []) {
      const idx = fulfillmentItems.findIndex(
        (i: any, n: number) =>
          !claimedFulfillmentIdx.has(n) &&
          ((i.item_id && i.item_id === item.id) ||
            (i.id && i.id === item.id))
      );
      if (idx !== -1) {
        claimedFulfillmentIdx.add(idx);
        preciseFiByOrderItemId.set(item.id, fulfillmentItems[idx]);
      }
    }
    const claimFulfillmentItem = (item: any): any => {
      const precise = preciseFiByOrderItemId.get(item.id);
      if (precise) return precise;
      const idx = fulfillmentItems.findIndex(
        (i: any, n: number) =>
          !claimedFulfillmentIdx.has(n) &&
          ((i.variant_id && i.variant_id === item.variant_id) ||
            (i.sku && item.variant?.sku && i.sku === item.variant.sku))
      );
      if (idx === -1) return null;
      claimedFulfillmentIdx.add(idx);
      return fulfillmentItems[idx];
    };

    const activeItems = (order.items || [])
      .filter((item: any) => {
        const fi = claimFulfillmentItem(item);

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
      .map((item: any) => {
        const quantity = item.fulfillment_quantity ?? item.quantity;
        // Original (pre-item-discount) resolution — preserved verbatim for
        // lines WITHOUT a per-line POS discount so non-POS fulfillments and
        // order-adjustment-based discounts are untouched.
        const baseUnitPrice =
          item.fulfillment_unit_price !== undefined
            ? getFloat(item.fulfillment_unit_price)
            : getFloat(item.unit_price);
        const baseSubtotal =
          item.fulfillment_total !== undefined
            ? getFloat(item.fulfillment_total)
            : item.subtotal !== undefined
              ? getFloat(item.subtotal)
              : undefined;

        // Per-line POS discount descriptor (set by the POS at sale time). When
        // present, the snapshot price is GROSS, so net the line down here.
        const lineDiscount = item.metadata?.line_discount as
          | { type?: string | null; value?: number | string | null }
          | null
          | undefined;
        const grossUnitPrice =
          item.fulfillment_unit_price !== undefined
            ? getFloat(item.fulfillment_unit_price)
            : getFloat(item.metadata?.original_unit_price ?? item.unit_price);
        const grossTotalCents = Math.round(grossUnitPrice * quantity * 100);
        // Computed exactly as pos_invoice.discount was (percent-on-gross /
        // fixed-per-unit) via the shared helper, so the subtraction below
        // cancels item-level discounts to the cent.
        const lineDiscountCentsComputed = invoiceLineDiscountCents(
          {
            discount_type: lineDiscount?.type ?? null,
            discount_value: lineDiscount?.value ?? null,
            quantity,
          },
          null,
          grossTotalCents
        );

        // Prefer the frozen net (round-then-multiply) when this invoice line carries
        // one — existing documents are protected here, via their backfilled frozen
        // value. When absent, the recompute above is itself round-then-multiply, so a
        // missing freeze still yields the correct number. The baked discount is
        // gross − net either way, so the order-level subtraction below stays correct.
        const netKey = `${item.variant_id ?? item.variant?.sku ?? "custom"}|${grossTotalCents}`;
        const storedNet = netByLine.get(netKey);
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
            // Net line subtotal → buildQbItems derives the discounted per-unit
            // price (subtotal / qty) and bakes the item discount into the line.
            subtotal: Math.max(0, grossTotalCents - lineDiscountCents) / 100,
          };
        }

        return {
          ...item,
          quantity,
          unit_price: baseUnitPrice,
          subtotal: baseSubtotal,
        };
      });

    // Order-level discount ONLY. When the invoice carries a snapshot discount
    // (pos_invoice.discount), strip the per-line discounts already baked into
    // the lines above; the remainder is the true order-level promotion. For
    // non-POS fulfillments (no snapshot) fall back to the order's effective
    // order-level discount, which excludes item-level discounts by design.
    const orderDiscountTotal =
      invoiceDiscountAmount !== undefined
        ? Math.max(0, invoiceDiscountAmount - lineDiscountTotalCents / 100)
        : getEffectiveOrderDiscount(order);

    const productTaxableMap = await resolveProductTaxableMap(
      _container.resolve("__pg_connection__"),
      activeItems
    );
    // Override with snapshot taxable values from pos_invoice_item (written by
    // DB trigger at invoice creation from product.taxable). This ensures QB
    // gets the taxable flag as it was when the invoice was issued, not the
    // current catalog state.
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
    invoiceDate,
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
