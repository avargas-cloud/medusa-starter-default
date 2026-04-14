import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";
import { Client } from "pg";
import {
  ensureCustomerInQb,
  buildQbItems,
  buildShippingQbItem,
} from "../../../../lib/quickbooks/order-flow-core";
import {
  createSalesReceiptInQb,
  voidSalesReceiptInQb,
} from "../../../../lib/quickbooks/qb-bridge-client";

/** Reads QB config from DB with .env fallback */
async function getQbConfig() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT shipping_item_id, default_sales_tax_code FROM quickbooks_config WHERE id = 'default' LIMIT 1`
    );
    const row = res.rows[0] || {};
    return {
      shippingItemId:
        row.shipping_item_id ||
        process.env.QB_SHIPPING_ITEM_ID ||
        "800006A3-1395258131",
      defaultSalesTaxCode:
        row.default_sales_tax_code ||
        process.env.QB_DEFAULT_SALES_TAX_CODE ||
        "Sale Tax 7%",
    };
  } catch {
    return {
      shippingItemId: process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
      defaultSalesTaxCode:
        process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
    };
  } finally {
    await client.end();
  }
}

/**
 * POST /admin/quickbooks/sales-receipt
 *
 * Creates a QuickBooks Sales Receipt for a completed POS sale (immediate payment).
 * Called by the POS app after creating the order in Medusa.
 *
 * Use this when the customer pays at point of sale (cash, card, etc).
 * For "pay later" / on-account sales, use the standard Sales Order flow instead.
 *
 * Body: { orderId: string, paymentMethod?: string, salesRep?: string }
 *   - paymentMethod: QB PaymentMethod FullName or ListID (e.g. "Cash", "Credit Card", "Check")
 *   - salesRep: QB SalesRep FullName or ListID (optional)
 *
 * Response: { success, operationId, message }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { orderId, paymentMethod, salesRep } = req.body as {
    orderId: string;
    paymentMethod?: string;
    salesRep?: string;
  };

  if (!orderId) {
    res.status(400).json({ error: "orderId is required" });
    return;
  }

  const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";
  if (!ENABLED) {
    res.json({
      success: true,
      skipped: true,
      message: "QB integration disabled",
    });
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER);
    const customerModule = req.scope.resolve(Modules.CUSTOMER);
    const qbConfig = await getQbConfig();

    // ── Fetch order ────────────────────────────────────────────────────────
    const query = (req.scope as any).resolve("query");
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "status",
        "metadata",
        "tax_total",
        "total",
        "currency_code",
        "customer_id",
        "sales_channel_id",
        "items.*",
        "items.item.unit_price",
        "items.variant.*",
        "items.variant.metadata",
        "customer.*",
        "customer.metadata",
        "shipping_methods.*",
      ],
      filters: { id: orderId },
    });

    if (!order) {
      res.status(404).json({ error: `Order ${orderId} not found` });
      return;
    }

    // ── Idempotency: already has a Sales Receipt? ──────────────────────────
    if (order.metadata?.qb_sales_receipt_txn_id) {
      res.json({
        success: true,
        skipped: true,
        txnId: order.metadata.qb_sales_receipt_txn_id,
        refNumber: order.metadata.qb_sales_receipt_ref,
        message: `Sales Receipt already exists (TxnID: ${order.metadata.qb_sales_receipt_txn_id})`,
      });
      return;
    }

    // ── Ensure customer exists in QB ───────────────────────────────────────
    let customer = order.customer ?? null;
    if (!customer && order.customer_id) {
      customer = await customerModule.retrieveCustomer(order.customer_id, {
        relations: ["addresses"],
      });
    }

    const custResult = await ensureCustomerInQb(customer, customerModule);
    if (!custResult.success || !custResult.qbCustomerId) {
      res
        .status(500)
        .json({ error: custResult.error || "Could not ensure customer in QB" });
      return;
    }
    const qbCustomerId = custResult.qbCustomerId;

    // ── Build items ────────────────────────────────────────────────────────
    const activeItems = (order.items || [])
      .filter((item: any) => (item.quantity ?? 0) > 0)
      .map((item: any) => ({
        ...item,
        // ⚠️  Admin API returns unit_price in DOLLARS — pass directly to QB bridge.
        //     Do NOT multiply by 100; QB bridge expects dollars in QBXML <Amount>.
        unit_price: item.unit_price || 0,
      }));

    const qbItems = buildQbItems(activeItems, order.metadata);

    const shippingItem = buildShippingQbItem(
      order.shipping_methods || [],
      qbConfig.shippingItemId
    );
    if (shippingItem) qbItems.push(shippingItem);

    const hasTax = order.tax_total && order.tax_total > 0;
    const salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined;

    // ── Create Sales Receipt in QB ─────────────────────────────────────────
    const result = await createSalesReceiptInQb({
      customerId: qbCustomerId,
      refNumber: String(order.display_id),
      items: qbItems,
      paymentMethod: paymentMethod || "Credit Card",
      salesRep: salesRep,
      salesTaxCode,
    });

    if (!result.success) {
      res
        .status(500)
        .json({
          error: result.error || "Failed to create Sales Receipt in QB",
        });
      return;
    }

    const operationId = result.data?.operationId;
    const txnId = result.data?.txnId;
    const refNumber = result.data?.refNumber;

    // ── Save metadata to order ─────────────────────────────────────────────
    await orderModule.updateOrders(orderId, {
      metadata: {
        ...(order.metadata || {}),
        qb_sales_receipt_operation_id: operationId || null,
        qb_sales_receipt_txn_id: txnId || null,
        qb_sales_receipt_ref: refNumber || null,
        qb_list_id: qbCustomerId,
        qb_synced_at: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      operationId,
      txnId,
      refNumber,
      message: txnId
        ? `Sales Receipt #${refNumber} created in QuickBooks`
        : `Sales Receipt creation queued (operationId: ${operationId})`,
    });
  } catch (err: any) {
    console.error("[QB-SALES-RECEIPT] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}

/**
 * DELETE /admin/quickbooks/sales-receipt
 *
 * Voids a Sales Receipt in QuickBooks (e.g., when a POS sale is cancelled/refunded).
 * Body: { orderId: string }
 */
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { orderId } = req.body as { orderId: string };

  if (!orderId) {
    res.status(400).json({ error: "orderId is required" });
    return;
  }

  const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";
  if (!ENABLED) {
    res.json({
      success: true,
      skipped: true,
      message: "QB integration disabled",
    });
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER);
    const order = await orderModule.retrieveOrder(orderId);

    const txnId = order.metadata?.qb_sales_receipt_txn_id as string | undefined;
    if (!txnId) {
      res.json({
        success: true,
        skipped: true,
        message: "No Sales Receipt TxnID found — nothing to void",
      });
      return;
    }

    const result = await voidSalesReceiptInQb(txnId);
    const operationId = result.data?.operationId;

    res.json({
      success: result.success,
      operationId,
      message: result.success
        ? `Sales Receipt ${txnId} void queued`
        : `Void failed: ${result.error}`,
    });
  } catch (err: any) {
    console.error("[QB-SALES-RECEIPT] Void Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
