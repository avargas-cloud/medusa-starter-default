import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import {
  ensureCustomerInQb,
  buildQbItems,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
  resolveProductTaxableMap,
  processOrderInQb,
} from "../../../../lib/quickbooks/order-flow-core";
import { parseSalesRepInitials } from "../../../../lib/quickbooks/parse-sales-rep";
import {
  updateSalesOrderInQb,
  pollOperationResult,
} from "../../../../lib/quickbooks/qb-bridge-client";
import { getQbConfig } from "../../../../lib/quickbooks/qb-config";
import {
  buildSaleOrderPatch,
  getSoTxnId,
  getSoRef,
  getEstimateTxnId,
} from "../../../../lib/quickbooks/qb-metadata-types";

/**
 * POST /admin/quickbooks/order
 *
 * Manually triggers QuickBooks Sales Order creation/sync for a confirmed Medusa Order.
 *
 * If the order metadata has qb_estimate_txn_id → calls convertEstimateToSalesOrder() in QB.
 * If no estimate → creates a brand-new SalesOrderAdd in QB.
 *
 * Body: { orderId: string, force?: boolean }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { orderId, force } = req.body as { orderId: string; force?: boolean };

  if (!orderId) {
    res.status(400).json({ error: "orderId is required" });
    return;
  }

  try {
    const qbConfig = await getQbConfig();
    const customerModule = req.scope.resolve(Modules.CUSTOMER);
    const baseUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

    // Fetch full order via internal admin API (includes items, customer, shipping)
    const orderResp = await fetch(
      `${baseUrl}/admin/orders/${orderId}?fields=id,display_id,status,metadata,tax_total,subtotal,discount_total,+items.*,+items.variant.*,+items.variant.metadata,+customer.*,+shipping_methods.*,+promotions.*,+promotions.application_method.*`,
      { headers: { cookie: req.headers.cookie || "" } }
    );

    if (!orderResp.ok) {
      const errText = await orderResp.text();
      res
        .status(orderResp.status)
        .json({ error: `Could not fetch order: ${errText}` });
      return;
    }

    const { order } = await orderResp.json();

    if (!order) {
      res.status(404).json({ error: `Order ${orderId} not found` });
      return;
    }

    // Only allow confirmed orders (not drafts)
    if (order.status === "draft") {
      res.status(400).json({
        error:
          "This is a Draft Order — use the Draft Order QB widget to sync as an Estimate first, then convert to a Sales Order.",
      });
      return;
    }

    // If already synced — block unless force=true
    const existingSoTxnId = getSoTxnId(order.metadata);
    const existingSoRef = getSoRef(order.metadata);
    if (existingSoTxnId && !force) {
      res.json({
        success: true,
        alreadySynced: true,
        qbSoTxnId: existingSoTxnId,
        qbSoRef: existingSoRef,
        message: `Already synced to QB Sales Order #${existingSoRef || existingSoTxnId}`,
      });
      return;
    }

    const customer = (order as any).customer as any;
    if (!customer) {
      res.status(400).json({ error: "Order has no customer assigned" });
      return;
    }

    // Ensure customer exists in QB
    const custResult = await ensureCustomerInQb(customer, customerModule);
    if (!custResult.success) {
      res.status(500).json({ error: `QB customer error: ${custResult.error}` });
      return;
    }

    const activeItems = (order.items || []).filter(
      (item: any) => (item.quantity ?? 0) > 0
    );

    // ── Discount strategy ─────────────────────────────────────────────────
    // ALL DISCOUNTS → keep original item prices + Subtotal + Discount lines.
    // Admin API returns discount_total in DOLLARS (e.g. 4.45) — convert to cents for buildQbOrderDiscountLines.
    const orderDiscountDollars = Number((order as any).discount_total ?? 0);
    const orderDiscountTotal = Math.round(orderDiscountDollars * 100); // dollars → cents

    // Admin API returns unit_price in DOLLARS (e.g. 22.25).
    // buildQbItems expects unit_price in CENTS — multiply ×100 like the subscriber does.
    const itemsForQb = activeItems.map((item: any) => ({
      ...item,
      unit_price: Math.round((item.unit_price || 0) * 100), // dollars → cents
      subtotal: undefined, // force original price, ignore item-level adjustments
    }));

    const productTaxableMap = await resolveProductTaxableMap(
      req.scope.resolve("__pg_connection__"),
      itemsForQb
    );
    const qbItems = buildQbItems(itemsForQb, order.metadata, productTaxableMap);

    // Append Subtotal + Discount lines BEFORE shipping so the Subtotal only sums products.
    // Shipping goes LAST — outside the Subtotal — so it's never included in the discount.
    if (orderDiscountTotal > 0) {
      const orderSubtotal = Math.round(
        Number((order as any).subtotal ?? 0) * 100
      ); // dollars → cents
      const discountPercent =
        orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null;
      buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(
        (l) => qbItems.push(l)
      );
    }

    // Add shipping LAST — after Subtotal+Discount so it's not counted in the discount
    const shippingItem = buildShippingQbItem(
      (order as any).shipping_methods || [],
      qbConfig.shippingItemId
    );
    if (shippingItem) qbItems.push(shippingItem);

    if (qbItems.length === 0) {
      res.status(400).json({
        error:
          "No items with a QuickBooks ID found. Make sure products have variant.metadata.quickbooks_id set.",
      });
      return;
    }

    // ─── RE-SYNC PATH (force=true + existing SO) — use SalesOrderMod ─────────
    const salesRep = parseSalesRepInitials(order.metadata?.sales_rep);
    if (force && existingSoTxnId) {
      console.log(
        `[QB] Re-sync: updating existing Sales Order ${existingSoTxnId} via MOD`
      );

      const modResult = await updateSalesOrderInQb({
        txnId: existingSoTxnId,
        customerId: custResult.qbCustomerId,
        items: qbItems,
        memo: `Medusa Order #${(order as any).display_id || orderId}`,
        salesTaxCode: qbConfig.defaultSalesTaxCode,
        ...(salesRep ? { salesRep } : {}),
      });

      if (!modResult.success) {
        res
          .status(500)
          .json({ error: `QB Sales Order mod failed: ${modResult.error}` });
        return;
      }

      // Poll for the mod result to get updated txnId/refNumber
      let txnId = existingSoTxnId;
      let refNumber = existingSoRef;

      if (
        modResult.data?.operationId &&
        modResult.data.operationId !== "DRY_RUN"
      ) {
        const polled = await pollOperationResult(modResult.data.operationId);
        txnId = polled.txnId || existingSoTxnId;
        refNumber = polled.refNumber || refNumber;
      }

      // Update metadata using patch builder
      const patch = buildSaleOrderPatch(order.metadata || {}, {
        txnId: txnId,
        refNumber: refNumber || null,
        operationId: modResult.data?.operationId || null,
      });
      await fetch(`${baseUrl}/admin/orders/${orderId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: req.headers.cookie || "",
        },
        body: JSON.stringify({ metadata: patch }),
      });

      res.json({
        success: true,
        alreadySynced: false,
        resync: true,
        qbSoTxnId: txnId,
        qbSoRef: refNumber,
        operationId: modResult.data?.operationId,
        message: `✅ Sales Order updated in QB (MOD)! TxnID: ${txnId}, Ref: ${refNumber || "pending"}`,
      });
      return;
    }

    // ─── INITIAL SYNC PATH — create new SO (Add or convert from Estimate) ────
    // IMPORTANT: pass activeItems with unit_price in DOLLARS (as returned by Admin API)
    // so that buildQbItems() constructs correct <Amount> values for QB Desktop.
    const orderForQb = {
      ...order,
      items: activeItems, // ← dollars (Admin API values, passed directly to QB)
      customer,
      // Preserve estimate metadata so QB converts Estimate → SO (not create new)
      metadata: order.metadata || {},
    };

    const result = await processOrderInQb(orderForQb, customerModule, {
      prebuiltItems: qbItems, // products + shipping (already built above)
      salesTaxCode: qbConfig.defaultSalesTaxCode, // same tax code as the estimate
    });

    if (!result.enabled) {
      res.status(503).json({
        error:
          "QuickBooks integration is disabled. Check QB_ORDER_FLOW_ENABLED env var.",
      });
      return;
    }
    if (result.skipped) {
      res.status(400).json({ error: `Skipped: ${result.skipReason}` });
      return;
    }
    if (result.error) {
      res.status(500).json({ error: result.error });
      return;
    }

    // Save QB metadata using patch builder
    const txnId = result.soTxnId;
    const refNumber = result.soRefNumber;

    if (txnId || result.operationId) {
      const patch = buildSaleOrderPatch(order.metadata || {}, {
        txnId: txnId || null,
        refNumber: refNumber || null,
        operationId: result.operationId || null,
      });
      await fetch(`${baseUrl}/admin/orders/${orderId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: req.headers.cookie || "",
        },
        body: JSON.stringify({ metadata: patch }),
      });
    }

    const isConversion = !!getEstimateTxnId(order.metadata);
    const action = isConversion
      ? "Estimate converted to Sales Order"
      : "Sales Order created";

    res.json({
      success: true,
      alreadySynced: false,
      qbSoTxnId: txnId,
      qbSoRef: refNumber,
      operationId: result.operationId,
      message: txnId
        ? `✅ ${action} in QB! TxnID: ${txnId}, Ref: ${refNumber || "pending"}`
        : `⏳ Sales Order queued in QB. OperationID: ${result.operationId}`,
    });
  } catch (err: any) {
    console.error("[QB] Error in manual order sync:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
}
