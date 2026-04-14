/**
 * order-flow-core.ts
 *
 * Orchestrates the complete QuickBooks flow for orders in Medusa.
 *
 * ARCHITECTURE:
 *   - All Bridge operations are ASYNC (return operationId).
 *   - We use "fire-and-poll" — queue the op, poll for txnId + refNumber.
 *   - Store BOTH txnId (for API calls) and refNumber (human-readable) in metadata.
 *   - ALL endpoints use customerId (QB ListID), NOT customerName.
 *
 * DISABLED BY DEFAULT: Controlled by QB_ORDER_FLOW_ENABLED env var.
 * DRY RUN: Set QB_DRY_RUN=true to simulate without writing to QuickBooks.
 *
 * Flow (Regular Order):
 *   1. Ensure customer exists in QB → save ListID to customer metadata
 *   2. Create Sales Order in QB → poll → save txnId + refNumber to order metadata
 *
 * Flow (Draft Order → Estimate):
 *   A. Create Estimate → poll → save txnId + refNumber to draft order metadata
 *   B. Convert Estimate → Sales Order → poll → save txnId + refNumber to order metadata
 *
 * Flow (Payment):
 *   3. Receive Payment (unapplied credit) → poll → save txnId + refNumber
 *
 * Flow (Invoice):
 *   4. Create Invoice linked to SO → poll → save txnId + refNumber
 *   5. Apply Payment to Invoice → closes the accounting loop
 *
 * Env vars:
 *   QB_ORDER_FLOW_ENABLED=false   — set to "true" to activate
 *   QB_DRY_RUN=false              — set to "true" to simulate without writing to QB
 */

import { buildQbCustomerName } from "./build-customer-name";
import { createSalesReceiptInQb } from "./client/sales-receipts";
import {
  checkBridgeHealth,
  createCustomerInQb,
  getCustomerEditSequence,
  updateCustomerInQb,
  createSalesOrderInQb,
  convertEstimateToSalesOrder,
  receivePaymentInQb,
  createInvoiceInQb,
  createEstimateInQb,
  updateEstimateInQb,
  deactivateEstimateInQb,
  applyPaymentToInvoiceInQb,
  pollOperationResult,
  QbOrderItem,
} from "./qb-bridge-client";
import { isQbIntegrationEnabled } from "./qb-integration-guard";
import { getEstimateTxnId } from "./qb-metadata-types";
import { getCachedEditSequence, writePipelineRow } from "./qb-pipeline";
import { QbSyncLogger } from "./qb-sync-logger";

const ORDER_FLOW_ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";
const DRY_RUN = process.env.QB_DRY_RUN === "true";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MedusaOrderForQb {
  id: string;
  display_id?: number;
  metadata?: Record<string, any>;
  customer?: {
    id: string;
    email?: string;
    first_name?: string | null;
    last_name?: string | null;
    company_name?: string | null;
    phone?: string | null;
    metadata?: Record<string, any>;
    addresses?: Array<{
      id: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      province?: string;
      postal_code?: string;
      is_default_billing?: boolean;
      is_default_shipping?: boolean;
      // metadata fallback (Medusa stores flags here too)
      metadata?: Record<string, any>;
    }>;
  };
  items?: Array<{
    variant?: {
      sku?: string;
      metadata?: Record<string, any>;
    };
    title?: string;
    product_title?: string;
    quantity: number;
    unit_price: number; // in cents (Medusa v2) — original price before discounts
    subtotal?: number; // in cents — post-adjustment (discounted) subtotal for the whole line
    metadata?: Record<string, any>;
  }>;
  created_at?: string | Date;
  tax_total?: number; // in cents (Medusa v2) — 0 = tax-exempt order
  discount_total?: number; // in cents — total discount applied to the order (for order-level promos)
}

export interface OrderFlowResult {
  enabled: boolean;
  dryRun?: boolean;
  skipped?: boolean;
  skipReason?: string;
  customerId?: string; // QB ListID (new or existing)
  operationId?: string; // Bridge async operation ID
  soTxnId?: string; // QB Sales Order TxnID (after polling)
  soRefNumber?: string; // QB Sales Order RefNumber (human-readable)
  editSequence?: string; // QB EditSequence (returned by Add/Mod responses)
  error?: string;
}

// ─── Shared: Guard Checks ──────────────────────────────────────────────────────

async function runGuards(): Promise<{
  pass: boolean;
  result?: OrderFlowResult;
}> {
  if (!ORDER_FLOW_ENABLED) {
    return {
      pass: false,
      result: {
        enabled: false,
        skipped: true,
        skipReason: "QB_ORDER_FLOW_ENABLED is false",
      },
    };
  }
  if (!(await isQbIntegrationEnabled())) {
    return {
      pass: false,
      result: {
        enabled: false,
        skipped: true,
        skipReason: "QB integration is disabled globally",
      },
    };
  }
  return { pass: true };
}

// ─── Shared: Ensure Customer in QB ─────────────────────────────────────────────

/**
 * Ensures the customer exists in QB. Creates if needed.
 * Returns the QB ListID (existing or newly created).
 */
export async function ensureCustomerInQb(
  customer: NonNullable<MedusaOrderForQb["customer"]>,
  customerModule: any,
  log: (msg: string) => void = console.log
): Promise<{ success: boolean; qbCustomerId?: string; error?: string }> {
  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  let qbCustomerId: string = customer.metadata?.qb_list_id;

  if (qbCustomerId) {
    log(`${prefix} Customer already in QB: ${qbCustomerId}`);
    return { success: true, qbCustomerId };
  }

  log(
    `${prefix} Customer ${customer.id} has no qb_list_id — creating in QB...`
  );

  const addrs = customer.addresses ?? [];

  // Resolve billing address: prefer is_default_billing flag, fall back to first address
  const billingAddress =
    addrs.find((a) => a.is_default_billing || a.metadata?.is_default_billing) ??
    addrs[0];

  // Resolve shipping address: prefer is_default_shipping flag, fall back to first address
  const shippingAddress =
    addrs.find(
      (a) => a.is_default_shipping || a.metadata?.is_default_shipping
    ) ?? addrs[0];

  const mapAddr = (a: (typeof addrs)[0] | undefined) =>
    a
      ? {
          Addr1: a.address_1,
          City: a.city,
          State: a.province,
          PostalCode: a.postal_code,
        }
      : undefined;

  const qbName = buildQbCustomerName(customer);

  // QB Enterprise 2012 native fields (no custom fields via QBXML):
  // Name, FirstName, LastName, CompanyName, Email, Phone,
  // BillAddress, ShipAddress, CustomerType, PriceLevel,
  // AltContact ("Alt. Contact" field), Cc ("Cc" field)
  const createResult = await createCustomerInQb({
    Name: qbName,
    FirstName: customer.first_name || undefined,
    LastName: customer.last_name || undefined,
    CompanyName: customer.company_name || undefined,
    Email: customer.email,
    Phone: customer.phone || undefined,
    BillAddress: mapAddr(billingAddress),
    ShipAddress: mapAddr(shippingAddress),
    CustomerType: customer.metadata?.qb_customer_type || undefined,
    PriceLevel: customer.metadata?.qb_price_level || undefined,
    AltContact: customer.metadata?.alt_contact || undefined,
    AltPhone: customer.metadata?.alt_phone || undefined,
    // Note: <Cc> is not valid in QBXML 10.0 — stored in Medusa metadata only
  });

  if (!createResult.success) {
    return {
      success: false,
      error: `Customer creation failed: ${createResult.error}`,
    };
  }

  qbCustomerId = createResult.data!.listId;

  // Save QB ListID back to Medusa customer metadata (skip on dry run)
  if (!DRY_RUN && qbCustomerId !== "DRY_RUN_ID") {
    try {
      await customerModule.updateCustomers(customer.id, {
        metadata: {
          ...(customer.metadata || {}),
          qb_list_id: qbCustomerId,
        },
      });
      log(
        `${prefix} ✅ Saved qb_list_id="${qbCustomerId}" to customer ${customer.id}`
      );
    } catch (metaErr: any) {
      console.error(
        `[QB] ⚠️ Could not save qb_list_id to customer: ${metaErr.message}`
      );
      // Non-fatal — QB customer was created, just metadata save failed
    }
  }

  return { success: true, qbCustomerId };
}

/**
 * Syncs all editable fields from a Medusa customer to QuickBooks via CustomerMod.
 * If the customer has no qb_list_id, creates it first via ensureCustomerInQb.
 *
 * Address mapping:
 *   - default_billing address → BillAddress
 *   - all other addresses     → ShipToAddress[] (keyed by Medusa address.id)
 *     On each sync, the FULL list is sent, so QB replaces ShipTo entries by Name:
 *     existing ShipTo with the same Name = updated; new ids = added.
 */
export async function syncCustomerToQb(
  customer: NonNullable<MedusaOrderForQb["customer"]>,
  customerModule: any,
  log: (msg: string) => void = console.log
): Promise<{ success: boolean; qbCustomerId?: string; error?: string }> {
  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";

  // No qb_list_id → create first
  const qbListId: string = customer.metadata?.qb_list_id;
  if (!qbListId) {
    log(
      `${prefix} Customer ${customer.id} has no qb_list_id — creating via syncCustomerToQb`
    );
    return ensureCustomerInQb(customer, customerModule, log);
  }

  log(`${prefix} Syncing customer ${customer.id} → QB ListID ${qbListId}`);

  // ── Get QB EditSequence (required for CustomerMod) ─────────────────
  const editSequence = await getCustomerEditSequence(qbListId, log);
  if (!editSequence) {
    return {
      success: false,
      error: `Could not get EditSequence for QB customer ${qbListId}`,
    };
  }

  // ── Map Medusa addresses to QB address types ────────────────────────
  const addrs = customer.addresses ?? [];

  const billingAddr = addrs.find(
    (a) => a.is_default_billing || a.metadata?.is_default_billing
  );
  const shippingAddr = addrs.find(
    (a) => !(a.is_default_billing || a.metadata?.is_default_billing)
  );
  // We intentionally ignore additional addresses; syncing them as ShipToAddress crashes QBW32 CustomerMod
  // B2B multi-location should be architected using the "Jobs" (Sub-Customers) pattern in QuickBooks instead.

  const mapAddr = (a: (typeof addrs)[0] | undefined) =>
    a
      ? {
          Addr1: a.address_1,
          Addr2: a.address_2,
          City: a.city,
          State: a.province,
          PostalCode: a.postal_code,
        }
      : undefined;

  const qbName = buildQbCustomerName(customer);

  // ── Send CustomerMod ───────────────────────────────────────────────
  const modResult = await updateCustomerInQb(
    {
      Name: qbName,
      ListID: qbListId,
      EditSequence: editSequence,
      FirstName: customer.first_name || undefined,
      LastName: customer.last_name || undefined,
      CompanyName: customer.company_name || undefined,
      Email: customer.email,
      Phone: customer.phone || undefined,
      BillAddress: mapAddr(billingAddr),
      ShipAddress: mapAddr(shippingAddr),
      // ShipToAddress is explicitly omitted
      CustomerType: customer.metadata?.qb_customer_type || undefined,
      PriceLevel: customer.metadata?.qb_price_level || undefined,
      AltContact: customer.metadata?.alt_contact || undefined,
      AltPhone: customer.metadata?.alt_phone || undefined,
    },
    log
  );

  if (!modResult.success) {
    return { success: false, error: modResult.error };
  }

  log(`${prefix} ✅ Customer ${customer.id} synced to QB successfully`);
  return { success: true, qbCustomerId: qbListId };
}

// ─── Shared: Build QB Items ────────────────────────────────────────────────────

/**
 * Strips characters that break QBXML (error 0x80040400):
 * em-dashes, smart quotes, and other non-ASCII Unicode.
 */
function sanitizeForQb(text: string): string {
  if (!text) return "";
  return text
    .replace(/[\u2013\u2014]/g, "-") // en/em-dash → hyphen
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes
    .replace(/[^\x00-\x7F]/g, "") // strip remaining non-ASCII
    .trim();
}

/**
 * Converts Medusa order items into QB order items.
 * Filters to only items that have a quickbooks_id in variant.metadata.
 * Sends the actual Medusa price as Rate — requires QB price lists to be disabled.
 * Set variant.metadata.quickbooks_uom (e.g. "each") to prevent QB UOM multiplication.
 * Also parses metadata.pos_comment_lines (if present) and interleaves them based on sort_order.
 */
export function buildQbItems(
  items: MedusaOrderForQb["items"],
  _metadata?: Record<string, any>
): QbOrderItem[] {
  const productLines = (items || [])
    .filter((item) => item.variant?.metadata?.quickbooks_id)
    .map((item) => {
      // Use discounted unit price if item has adjustments (item.subtotal < unit_price * qty).
      // Both item-level discounts (per-item promotions) and order-level distributed discounts
      // are reflected here. Price is always per-unit in dollars for QB.
      const originalTotal = (item.unit_price || 0) * item.quantity;
      const effectiveUnitPrice =
        item.subtotal !== undefined &&
        item.subtotal < originalTotal &&
        item.subtotal > 0
          ? Number((item.subtotal / item.quantity).toFixed(2)) // discounted subtotal ÷ qty
          : item.unit_price || 0; // no discount → original unit price
      return {
        _sortOrder:
          typeof item.metadata?.sort_order === "number"
            ? item.metadata.sort_order
            : 9999,
        qbItem: {
          productId: item.variant!.metadata!.quickbooks_id as string,
          quantity: item.quantity,
          price: effectiveUnitPrice,
          amount: Number((effectiveUnitPrice * item.quantity).toFixed(2)),
          unitOfMeasure:
            (item.variant?.metadata?.quickbooks_uom as string) || undefined,
          desc: sanitizeForQb(
            item.metadata?.sales_description
              ? String(item.metadata.sales_description)
              : `${item.title || item.product_title || ""}${item.variant?.sku ? ` (${item.variant.sku})` : ""}`
          ),
        },
      };
    });

  const allLines = [...productLines];
  allLines.sort((a, b) => a._sortOrder - b._sortOrder);

  return allLines.map((line) => line.qbItem);
}

/**
 * Builds the two QB line items for an order-level discount:
 *   1. "Subtotal" — QB Subtotal item type. QB automatically sums all lines above it.
 *   2. "Discount" — QB Discount item type with the EXACT dollar amount from Medusa.
 *
 * Use this ONLY for order-level promotions (applied to the whole order, e.g. coupon codes).
 * Do NOT use when discounts are already baked into item unit prices (item-level promotions).
 *
 * @param discountTotalCents - Total order-level discount in cents (positive value)
 * @param discountPercent    - Optional human-readable % to include in the description
 */
export function buildQbOrderDiscountLines(
  discountTotal: number,
  discountPercent?: number | null
): QbOrderItem[] {
  if (!discountTotal || discountTotal <= 0) return [];

  const discountDollars = discountTotal;
  const pctStr =
    discountPercent != null ? ` (${discountPercent.toFixed(0)}%)` : "";

  return [
    {
      // QB Subtotal item — totals everything ABOVE it (products only; shipping comes after).
      // IMPORTANT: QB Subtotal item type does NOT accept Quantity (Error 3060). Omit it entirely.
      productName: "Subtotal",
      desc: "Order Item Subtotal",
      noSite: true,
    },
    {
      // QB Discount item — exact dollar amount so QB doesn't recalculate via %.
      // IMPORTANT: QB Discount item type does NOT accept Quantity either. Omit it; use price only.
      productName: "Discount",
      price: discountDollars,
      amount: discountDollars,
      desc: sanitizeForQb(`Order Discount${pctStr}`),
      noSite: true,
    },
  ];
}

/**
 * Builds a QB line item for shipping (if applicable).
 *
 * Rules:
 *  - If no shipping methods → return null
 *  - If shipping method name contains "pickup" (case-insensitive) → return null (store pickup)
 *  - Otherwise → return a QB item using the "SHIPPING & HANDLING" product name,
 *    qty=1, price=shipping amount, desc=shipping method name
 *
 * @param shippingMethods - Array of shipping methods from the Medusa order (admin API, amounts in dollars)
 */
export function buildShippingQbItem(
  shippingMethods: any[],
  shippingItemIdOverride?: string
): QbOrderItem | null {
  if (!shippingMethods?.length) return null;

  const PICKUP_KEYWORDS = [
    "pickup",
    "pick up",
    "pick-up",
    "store pickup",
    "local pickup",
    "in-store",
  ];

  const nonPickup = shippingMethods.filter((m) => {
    const name = (
      m.name ||
      m.shipping_option?.name ||
      m.label ||
      ""
    ).toLowerCase();
    return !PICKUP_KEYWORDS.some((kw) => name.includes(kw));
  });

  if (!nonPickup.length) return null;

  // Use the first non-pickup method
  const method = nonPickup[0];
  const amount = Number(method.amount || 0); // dollars from admin API
  const name = sanitizeForQb(
    method.name || method.shipping_option?.name || "Shipping"
  );

  if (amount <= 0) return null; // free shipping — no need to add a line

  return {
    // Use QB ListID from DB config, env var, or hardcoded fallback.
    // Do NOT use productName "SHIPPING & HANDLING" — the & causes QB QBXML parser error 0x80040400.
    productId:
      shippingItemIdOverride ||
      process.env.QB_SHIPPING_ITEM_ID ||
      "800006A3-1395258131",
    quantity: 1,
    price: amount, // dollars → QB sends Amount = price * qty
    amount: amount,
    desc: name,
    noSite: true, // shipping is a non-inventory item — QB error 3140 if Site is set
  };
}

// ─── 1. Process Order → Sales Order ───────────────────────────────────────────

/**
 * Main orchestrator: Order placed → ensure customer → create Sales Order.
 * Called by the qb-order-subscriber on `order.placed`.
 */
export async function processOrderInQb(
  order: MedusaOrderForQb,
  customerModule: any,
  options?: {
    prebuiltItems?: QbOrderItem[];
    salesTaxCode?: string;
    memo?: string;
    salesRep?: string;
    onSubmitted?: (operationId: string) => Promise<void>;
  }
): Promise<OrderFlowResult> {
  const guard = await runGuards();
  if (!guard.pass) return guard.result!;

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  console.log(
    `${prefix} Processing order #${order.display_id || order.id} in QuickBooks...`
  );

  const logId = await QbSyncLogger.start({
    operation: "sales_order",
    orderId: order.id,
    orderDisplayId: order.display_id,
    eventType: "order.placed",
    triggeredBy: "event",
    message: `Creating Sales Order for order #${order.display_id || order.id}`,
  });

  try {
    // 1. Health check
    const healthy = await checkBridgeHealth();
    if (!healthy && !DRY_RUN) {
      console.warn(
        `[QB] ⚠️ Bridge health check failed. Order #${order.display_id} will NOT be sent to QB.`
      );
      await QbSyncLogger.skip(logId, "Bridge unreachable");
      return { enabled: true, skipped: true, skipReason: "Bridge unreachable" };
    }

    // 2. Ensure customer exists in QB
    const customer = order.customer;
    if (!customer) {
      await QbSyncLogger.skip(logId, "Order has no customer data");
      return {
        enabled: true,
        skipped: true,
        skipReason: "Order has no customer data",
      };
    }

    const custResult = await ensureCustomerInQb(customer, customerModule);
    if (!custResult.success) {
      await QbSyncLogger.fail(
        logId,
        custResult.error || "Customer creation failed"
      );
      return { enabled: true, error: custResult.error };
    }
    const qbCustomerId = custResult.qbCustomerId!;

    // 3. Build Sales Order items
    // Use pre-built items if provided (allows caller to inject shipping line).
    // Fallback: build from order.items (subscriber path — no shipping).
    const soItems =
      options?.prebuiltItems ?? buildQbItems(order.items, order.metadata);

    if (soItems.length === 0) {
      console.warn(
        `${prefix} ⚠️ Order #${order.display_id} has no items with quickbooks_id — skipping SO creation`
      );
      await QbSyncLogger.skip(logId, "No QB-linked items in order");
      return {
        enabled: true,
        dryRun: DRY_RUN,
        customerId: qbCustomerId,
        skipReason: "No QB-linked items in order",
      };
    }

    // 4. Check if this order came from a Draft (has estimate to convert)
    // Use getEstimateTxnId() to handle both new shape (qb_estimate.txn_id) and old flat field
    const estimateTxnId = getEstimateTxnId(order.metadata);
    const taxExempt = !order.tax_total || order.tax_total === 0;
    let soResult;

    if (estimateTxnId) {
      console.log(
        `${prefix} Order derived from estimate ${estimateTxnId} — converting to Sales Order...`
      );
      soResult = await convertEstimateToSalesOrder({
        estimateTxnId,
        customerId: qbCustomerId,
        date: getDateString(order.created_at),
        items: soItems,
        taxExempt,
        salesTaxCode: options?.salesTaxCode,
        memo: options?.memo
          ? `${options.memo} — from Estimate ${order.metadata?.original_estimate_number || order.metadata?.qb_estimate_ref || estimateTxnId}`
          : `Order ${order.metadata?.document_number || order.display_id || order.id} — from Estimate ${order.metadata?.original_estimate_number || order.metadata?.qb_estimate_ref || estimateTxnId}`,
      });
    } else {
      const orderDate = getDateString(order.created_at);
      soResult = await createSalesOrderInQb({
        customerId: qbCustomerId,
        date: orderDate,
        items: soItems,
        taxExempt,
        salesTaxCode: options?.salesTaxCode,
        salesRep: options?.salesRep,
        memo:
          options?.memo ||
          `Order ${order.metadata?.document_number || order.display_id || order.id}`,
      });
    }

    if (!soResult.success) {
      console.error(`[QB] ❌ Failed to create Sales Order: ${soResult.error}`);
      await QbSyncLogger.fail(logId, `SO creation failed: ${soResult.error}`);
      return {
        enabled: true,
        dryRun: DRY_RUN,
        customerId: qbCustomerId,
        error: `SO creation failed: ${soResult.error}`,
      };
    }

    const asyncData = soResult.data!;
    console.log(
      `${prefix} ✅ Sales Order queued. OperationID: ${asyncData.operationId}`
    );
    QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

    if (options?.onSubmitted && asyncData.operationId !== "DRY_RUN") {
      try {
        await options.onSubmitted(asyncData.operationId);
      } catch {}
    }

    // 5. Poll for result (txnId + refNumber + editSequence)
    let txnId = asyncData.txnId;
    let refNumber = asyncData.refNumber;
    let editSequence: string | undefined;

    if (!txnId && asyncData.operationId !== "DRY_RUN") {
      try {
        const pollResult = await pollOperationResult(asyncData.operationId);
        txnId = pollResult.txnId;
        refNumber = pollResult.refNumber;
        editSequence = pollResult.editSequence;
      } catch (pollErr: any) {
        console.error(`[QB] ❌ Polling failed: ${pollErr.message}`);
        await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
        return { enabled: true, error: `Polling failed: ${pollErr.message}` };
      }
    }

    if (txnId) {
      console.log(
        `${prefix} ✅ Sales Order created. TxnID: ${txnId}, Ref: ${refNumber || "pending"}, EditSeq: ${editSequence ?? "none"}`
      );
    }

    await QbSyncLogger.complete(logId, {
      qbTxnId: txnId,
      qbRefNumber: refNumber,
      qbOperationId: asyncData.operationId,
      message: txnId
        ? `Sales Order created — TxnID: ${txnId}, Ref: ${refNumber || "pending"}`
        : `Sales Order queued — OperationID: ${asyncData.operationId}`,
      metadata: { qbCustomerId, dryRun: DRY_RUN },
    });

    return {
      enabled: true,
      dryRun: DRY_RUN,
      customerId: qbCustomerId,
      operationId: asyncData.operationId,
      soTxnId: txnId,
      soRefNumber: refNumber,
      editSequence,
    };
  } catch (err: any) {
    console.error(
      `[QB] ❌ Unexpected error in processOrderInQb: ${err.message}`
    );
    await QbSyncLogger.fail(logId, err.message);
    return { enabled: true, error: err.message };
  }
}

// ─── 2. Process Payment Capture ───────────────────────────────────────────────

/**
 * Called when a payment is captured in Medusa.
 * Records the payment in QB as an unapplied credit (Step 2 of the QB flow).
 */
export async function processPaymentCaptureInQb(capture: {
  orderId: string;
  orderDisplayId?: number;
  amount: number; // in cents (Medusa v2)
  paymentMethod?: string;
  qbCustomerId: string;
  refNumber?: string;
  memo?: string;
  onSubmitted?: (operationId: string) => Promise<void>;
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  refNumber?: string;
  editSequence?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  const amountDollars = capture.amount;

  console.log(
    `${prefix} Recording payment of $${amountDollars.toFixed(2)} for order #${capture.orderDisplayId || capture.orderId}...`
  );

  const paymentMemo =
    capture.memo ||
    `Payment for Order ${capture.orderDisplayId || capture.orderId}`;

  const logId = await QbSyncLogger.start({
    operation: "payment",
    orderId: capture.orderId,
    orderDisplayId: capture.orderDisplayId,
    eventType: "order.payment_captured",
    triggeredBy: "event",
    message: `Recording payment of $${amountDollars.toFixed(2)}`,
    metadata: { amount: amountDollars, paymentMethod: capture.paymentMethod },
  });

  const result = await receivePaymentInQb({
    customerId: capture.qbCustomerId,
    amount: amountDollars,
    paymentMethod: capture.paymentMethod,
    memo: paymentMemo,
    autoApply: false,
  });

  if (!result.success) {
    console.error(`[QB] ❌ Failed to record payment: ${result.error}`);
    await QbSyncLogger.fail(logId, result.error || "Payment failed");
    return { enabled: true, error: result.error };
  }

  const asyncData = result.data!;
  console.log(
    `${prefix} ✅ Payment queued. OperationID: ${asyncData.operationId}`
  );
  QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

  if (capture.onSubmitted && asyncData.operationId !== "DRY_RUN") {
    try {
      await capture.onSubmitted(asyncData.operationId);
    } catch {}
  }

  let txnId = asyncData.txnId;
  let refNumber = asyncData.refNumber;
  let editSequence: string | undefined;

  if (!txnId && asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      txnId = pollResult.txnId;
      refNumber = pollResult.refNumber;
      editSequence = pollResult.editSequence;
    } catch (pollErr: any) {
      console.error(`[QB] ❌ Payment polling failed: ${pollErr.message}`);
      await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
      return { enabled: true, error: `Polling failed: ${pollErr.message}` };
    }
  }

  if (txnId) {
    console.log(
      `${prefix} ✅ Payment recorded. TxnID: ${txnId}, Ref: ${refNumber || "pending"}`
    );
  }

  await QbSyncLogger.complete(logId, {
    qbTxnId: txnId,
    qbRefNumber: refNumber,
    qbOperationId: asyncData.operationId,
    message: txnId
      ? `Payment recorded — $${amountDollars.toFixed(2)}, TxnID: ${txnId}`
      : `Payment queued — OperationID: ${asyncData.operationId}`,
  });

  return {
    enabled: true,
    operationId: asyncData.operationId,
    txnId,
    refNumber,
    editSequence,
  };
}

// ─── 3. Process Invoice (Fulfillment) ─────────────────────────────────────────

/**
 * Called when an order is fulfilled/shipped.
 * Creates an Invoice in QB linked to the Sales Order, then applies the payment credit.
 */
export async function processInvoiceInQb(invoice: {
  orderId: string;
  orderDisplayId?: number;
  qbCustomerId: string;
  qbSoTxnId?: string; // Make optional for direct invoices
  qbPaymentTxnId?: string;
  paymentAmount?: number;
  prebuiltItems?: QbOrderItem[]; // Used if no qbSoTxnId
  salesTaxCode?: string; // Used if no qbSoTxnId
  salesRep?: string;
  refNumber?: string; // Custom Invoice Number
  memo?: string;
  onSubmitted?: (operationId: string) => Promise<void>; // Persist bridge_op_id before polling
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  refNumber?: string;
  editSequence?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";

  const logId = await QbSyncLogger.start({
    operation: "invoice",
    orderId: invoice.orderId,
    orderDisplayId: invoice.orderDisplayId,
    eventType: "order.fulfillment_created",
    triggeredBy: "event",
    message: `Creating Invoice for order #${invoice.orderDisplayId || invoice.orderId}${invoice.qbSoTxnId ? ` linked to SO: ${invoice.qbSoTxnId}` : " (Direct Invoice)"}`,
    metadata: {
      qbSoTxnId: invoice.qbSoTxnId,
      qbPaymentTxnId: invoice.qbPaymentTxnId,
    },
  });

  console.log(
    `${prefix} Creating Invoice for order #${invoice.orderDisplayId || invoice.orderId}${invoice.qbSoTxnId ? ` linked to SO: ${invoice.qbSoTxnId}` : " (Direct Invoice)"}...`
  );

  const invResult = await createInvoiceInQb({
    customerId: invoice.qbCustomerId,
    date: getDateString(),
    LinkToTxnID: invoice.qbSoTxnId,
    items: invoice.prebuiltItems,
    salesTaxCode: invoice.salesTaxCode,
    salesRep: invoice.salesRep,
    memo:
      invoice.memo || `Invoice ${invoice.orderDisplayId || invoice.orderId}`,
  });

  if (!invResult.success) {
    console.error(`[QB] ❌ Failed to create Invoice: ${invResult.error}`);
    await QbSyncLogger.fail(
      logId,
      invResult.error || "Invoice creation failed"
    );
    return { enabled: true, error: invResult.error };
  }

  const asyncData = invResult.data!;
  console.log(
    `${prefix} ✅ Invoice queued. OperationID: ${asyncData.operationId}`
  );
  QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

  // Persist bridge_op_id immediately so Retry can re-poll even if server crashes during polling
  if (invoice.onSubmitted && asyncData.operationId !== "DRY_RUN") {
    try {
      await invoice.onSubmitted(asyncData.operationId);
    } catch {}
  }

  let invTxnId = asyncData.txnId;
  let invRefNumber = asyncData.refNumber;
  let invEditSequence: string | undefined;

  if (!invTxnId && asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      invTxnId = pollResult.txnId;
      invRefNumber = pollResult.refNumber;
      invEditSequence = pollResult.editSequence;
    } catch (pollErr: any) {
      console.error(`[QB] ❌ Invoice polling failed: ${pollErr.message}`);
      await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
      return { enabled: true, error: `Polling failed: ${pollErr.message}` };
    }
  }

  if (invTxnId) {
    console.log(
      `${prefix} ✅ Invoice created. TxnID: ${invTxnId}, Ref: ${invRefNumber || "pending"}, EditSeq: ${invEditSequence ?? "none"}`
    );
  }

  if (invTxnId && invoice.qbPaymentTxnId && invoice.paymentAmount) {
    console.log(
      `${prefix} Applying payment ${invoice.qbPaymentTxnId} to invoice ${invTxnId}...`
    );

    const cachedEditSeqEntry = await getCachedEditSequence(
      "payment",
      invoice.qbPaymentTxnId
    ).catch(() => null);
    const cachedEditSeq = cachedEditSeqEntry?.editSeq ?? null;
    if (!cachedEditSeq) {
      console.warn(
        `[QB] ⚠️ No EditSequence in cache for payment ${invoice.qbPaymentTxnId}. Skipping apply to avoid duplicate QB record.`
      );
    }

    const applyResult = cachedEditSeq
      ? await applyPaymentToInvoiceInQb({
          customerId: invoice.qbCustomerId,
          amount: invoice.paymentAmount,
          invoiceId: invTxnId,
          creditTxnId: invoice.qbPaymentTxnId,
          editSequence: cachedEditSeq,
        })
      : { success: false, error: "EditSequence not cached" };

    if (!applyResult.success) {
      console.error(
        `[QB] ⚠️ Failed to apply payment to invoice (non-blocking): ${applyResult.error}`
      );
    } else {
      console.log(`${prefix} ✅ Payment applied to Invoice.`);
    }
  }

  await QbSyncLogger.complete(logId, {
    qbTxnId: invTxnId,
    qbRefNumber: invRefNumber,
    qbOperationId: asyncData.operationId,
    message: invTxnId
      ? `Invoice created — TxnID: ${invTxnId}${invoice.qbPaymentTxnId ? " + payment applied" : ""}`
      : `Invoice queued — OperationID: ${asyncData.operationId}`,
  });

  return {
    enabled: true,
    operationId: asyncData.operationId,
    txnId: invTxnId,
    refNumber: invRefNumber,
    editSequence: invEditSequence,
  };
}

// ─── 3.5 Process Sales Receipt (Fully Paid POS Cash Sale) ──────────────────────

/**
 * Canonical POS → QB Payment Method name mapping.
 *
 * These values MUST match the `FullName` of entries in the Payment Method
 * List in QuickBooks Desktop. A mismatch (e.g. "MasterCard" vs "Mastercard")
 * causes QB to silently ignore the PaymentMethodRef and leave the field
 * blank on the resulting Sales Receipt / ReceivePayment.
 *
 * Keep this in sync with `QB_PAYMENT_METHOD_NAMES` in
 * /api/admin/customer-payments/[id]/route.ts.
 */
export const QB_PAYMENT_METHOD_NAMES: Record<string, string> = {
  cash: "Cash",
  visa: "Visa",
  mastercard: "Mastercard",
  discover: "Discover",
  amex: "American Express",
  capital_one: "Capital One",
  debit_card: "Debit Card",
  check: "Check",
  money_order: "Check",
  checking_account: "ACH / Bank Transfer",
  e_check: "ACH / Bank Transfer",
  transfer: "ACH / Bank Transfer",
  ach: "ACH / Bank Transfer",
  wire_transfer: "Wire Transfer",
  zelle: "Zelle",
  paypal: "Other",
};

function mapPaymentMethodToQb(method: string | undefined): string | undefined {
  if (!method) return undefined;
  const m = method.toLowerCase().trim().replace(/\s+/g, "_");
  if (QB_PAYMENT_METHOD_NAMES[m]) return QB_PAYMENT_METHOD_NAMES[m];
  // Generic aliases — should not be sent as a specific QB method
  if (m === "card" || m === "credit_card" || m === "credit") return undefined;
  // Unknown value — return undefined so QB leaves the field blank rather
  // than sending a name QB Desktop has no entry for.
  return undefined;
}

/**
 * Called when an order is completed natively at the POS and fully paid at the time of creation.
 * Creates a Sales Receipt in QB matching the payment directly without using Sales Order / Invoice / ReceivePayment.
 */
export async function processSalesReceiptInQb(receipt: {
  orderId: string;
  orderDisplayId?: number;
  qbCustomerId: string;
  paymentMethod?: string;
  prebuiltItems?: QbOrderItem[];
  onSubmitted?: (operationId: string) => Promise<void>; // Persist bridge_op_id before polling
  salesTaxCode?: string;
  salesRep?: string;
  refNumber?: string;
  memo?: string;
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  refNumber?: string;
  editSequence?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";

  const logId = await QbSyncLogger.start({
    operation: "sales_receipt",
    orderId: receipt.orderId,
    orderDisplayId: receipt.orderDisplayId,
    eventType: "pos.sales_receipt.created",
    triggeredBy: "event",
    message: `Creating Sales Receipt for order #${receipt.orderDisplayId || receipt.orderId}`,
    metadata: { paymentMethod: receipt.paymentMethod },
  });

  console.log(
    `${prefix} Creating Sales Receipt for order #${receipt.orderDisplayId || receipt.orderId}...`
  );

  const srResult = await createSalesReceiptInQb({
    customerId: receipt.qbCustomerId,
    date: getDateString(),
    items: receipt.prebuiltItems || [],
    salesTaxCode: receipt.salesTaxCode,
    salesRep: receipt.salesRep,
    paymentMethod: mapPaymentMethodToQb(receipt.paymentMethod),
    memo:
      receipt.memo ||
      `Sales Receipt for Order ${receipt.orderDisplayId || receipt.orderId}`,
  });

  if (!srResult.success) {
    console.error(`[QB] ❌ Failed to create Sales Receipt: ${srResult.error}`);
    await QbSyncLogger.fail(
      logId,
      srResult.error || "Sales Receipt creation failed"
    );
    return { enabled: true, error: srResult.error };
  }

  const asyncData = srResult.data!;
  console.log(
    `${prefix} ✅ Sales Receipt queued. OperationID: ${asyncData.operationId}`
  );
  QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

  // Persist bridge_op_id immediately so Retry can re-poll even if server crashes during polling
  if (receipt.onSubmitted && asyncData.operationId !== "DRY_RUN") {
    try {
      await receipt.onSubmitted(asyncData.operationId);
    } catch {}
  }

  let srTxnId = asyncData.txnId;
  let srRefNumber = asyncData.refNumber;
  let srEditSequence: string | undefined;

  if (!srTxnId && asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      srTxnId = pollResult.txnId;
      srRefNumber = pollResult.refNumber;
      srEditSequence = pollResult.editSequence;
    } catch (pollErr: any) {
      console.error(`[QB] ❌ Sales Receipt polling failed: ${pollErr.message}`);
      await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
      return { enabled: true, error: `Polling failed: ${pollErr.message}` };
    }
  }

  if (srTxnId) {
    console.log(
      `${prefix} ✅ Sales Receipt created. TxnID: ${srTxnId}, Ref: ${srRefNumber || "pending"}, EditSeq: ${srEditSequence ?? "none"}`
    );
  }

  await QbSyncLogger.complete(logId, {
    qbTxnId: srTxnId,
    qbRefNumber: srRefNumber,
    qbOperationId: asyncData.operationId,
    message: srTxnId
      ? `Sales Receipt created — TxnID: ${srTxnId}`
      : `Sales Receipt queued — OperationID: ${asyncData.operationId}`,
  });

  return {
    enabled: true,
    operationId: asyncData.operationId,
    txnId: srTxnId,
    refNumber: srRefNumber,
    editSequence: srEditSequence,
  };
}

// ─── 4. Process Estimate (Draft Order) ────────────────────────────────────────

/**
 * Called when a Draft Order is created in Medusa Admin.
 * Creates an Estimate in QB for the draft.
 */
export async function processEstimateInQb(draft: {
  draftOrderId: string;
  qbCustomerId: string;
  items: QbOrderItem[];
  memo?: string;
  date?: string;
  taxExempt?: boolean;
  salesTaxCode?: string;
  salesRep?: string;
  onSubmitted?: (operationId: string) => Promise<void>;
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  refNumber?: string;
  editSequence?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  console.log(
    `${prefix} Creating Estimate for draft order ${draft.draftOrderId}...`
  );

  const logId = await QbSyncLogger.start({
    operation: "estimate",
    draftOrderId: draft.draftOrderId,
    eventType: "draft_order.created",
    triggeredBy: "event",
    message: `Creating Estimate for draft order ${draft.draftOrderId}`,
  });

  if (draft.items.length === 0) {
    console.warn(
      `${prefix} ⚠️ Draft order has no QB-linked items — skipping Estimate`
    );
    await QbSyncLogger.skip(logId, "No QB-linked items in draft order");
    return { enabled: true, skipped: true };
  }

  const estResult = await createEstimateInQb({
    customerId: draft.qbCustomerId,
    date: draft.date || getDateString(),
    items: draft.items,
    memo: draft.memo || `E${draft.draftOrderId}`,
    ...(draft.taxExempt === true ? { taxExempt: true } : {}),
    ...(draft.salesTaxCode ? { salesTaxCode: draft.salesTaxCode } : {}),
    ...(draft.salesRep ? { salesRep: draft.salesRep } : {}),
  });

  if (!estResult.success) {
    console.error(`[QB] ❌ Failed to create Estimate: ${estResult.error}`);
    await QbSyncLogger.fail(
      logId,
      estResult.error || "Estimate creation failed"
    );
    return { enabled: true, error: estResult.error };
  }

  const asyncData = estResult.data!;
  console.log(
    `${prefix} ✅ Estimate queued. OperationID: ${asyncData.operationId}`
  );
  QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

  if (draft.onSubmitted && asyncData.operationId !== "DRY_RUN") {
    try {
      await draft.onSubmitted(asyncData.operationId);
    } catch {}
  }

  let txnId = asyncData.txnId;
  let refNumber = asyncData.refNumber;
  let editSequence: string | undefined;

  if (!txnId && asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      txnId = pollResult.txnId;
      refNumber = pollResult.refNumber;
      editSequence = pollResult.editSequence;
    } catch (pollErr: any) {
      console.error(`[QB] ❌ Estimate polling failed: ${pollErr.message}`);
      await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
      return { enabled: true, error: `Polling failed: ${pollErr.message}` };
    }
  }

  if (txnId) {
    console.log(
      `${prefix} ✅ Estimate created. TxnID: ${txnId}, Ref: ${refNumber || "pending"}, EditSeq: ${editSequence || "—"}`
    );
  }

  await QbSyncLogger.complete(logId, {
    qbTxnId: txnId,
    qbRefNumber: refNumber,
    qbOperationId: asyncData.operationId,
    message: txnId
      ? `Estimate created — TxnID: ${txnId}, Ref: ${refNumber || "pending"}`
      : `Estimate queued — OperationID: ${asyncData.operationId}`,
  });

  return {
    enabled: true,
    operationId: asyncData.operationId,
    txnId,
    refNumber,
    editSequence,
  };
}

// ─── 5. Update Estimate (Draft Order Re-sync) ──────────────────────────────────

/**
 * Called when "Re-sync to QuickBooks" is pressed on a Draft Order that was
 * already synced as an Estimate. Edits the existing QB Estimate (MOD) with
 * the current items/prices — does NOT create a new Estimate.
 */
export async function processUpdateEstimateInQb(draft: {
  draftOrderId: string;
  estimateTxnId: string; // existing qb_estimate_txn_id from order metadata
  items: QbOrderItem[];
  memo?: string;
  taxExempt?: boolean; // true if Medusa order has no tax (tax_total === 0)
  salesTaxCode?: string; // QB sales tax code name — overrides customer default
  salesRep?: string; // QB sales rep initials (e.g. "AVP", "AG")
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  refNumber?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  console.log(
    `${prefix} Updating Estimate ${draft.estimateTxnId} for draft order ${draft.draftOrderId}...`
  );

  const logId = await QbSyncLogger.start({
    operation: "estimate",
    draftOrderId: draft.draftOrderId,
    eventType: "draft_order.updated",
    triggeredBy: "manual",
    message: `Re-syncing Estimate ${draft.estimateTxnId} for draft order ${draft.draftOrderId}`,
  });

  if (draft.items.length === 0) {
    await QbSyncLogger.skip(logId, "No QB-linked items in draft order");
    return {
      enabled: true,
      skipped: true,
      skipReason: "No QB-linked items in draft order",
    };
  }

  const estResult = await updateEstimateInQb({
    txnId: draft.estimateTxnId,
    items: draft.items,
    memo: draft.memo,
    ...(draft.taxExempt === true ? { taxExempt: true } : {}),
    ...(draft.salesTaxCode ? { salesTaxCode: draft.salesTaxCode } : {}),
    ...(draft.salesRep ? { salesRep: draft.salesRep } : {}),
  });

  if (!estResult.success) {
    console.error(`[QB] ❌ Failed to update Estimate: ${estResult.error}`);
    await QbSyncLogger.fail(logId, estResult.error || "Estimate update failed");
    return { enabled: true, error: estResult.error };
  }

  const asyncData = estResult.data!;
  console.log(
    `${prefix} ✅ Estimate update queued. OperationID: ${asyncData.operationId}`
  );
  QbSyncLogger.setOperationId(logId, asyncData.operationId).catch(() => {});

  let txnId = asyncData.txnId || draft.estimateTxnId;
  let refNumber: string | undefined;

  if (asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      if (pollResult.txnId) txnId = pollResult.txnId;
      refNumber = pollResult.refNumber;
    } catch (pollErr: any) {
      console.error(
        `[QB] ❌ Estimate update polling failed: ${pollErr.message}`
      );
      await QbSyncLogger.fail(logId, `Polling failed: ${pollErr.message}`);
      return { enabled: true, error: `Polling failed: ${pollErr.message}` };
    }
  }

  console.log(`${prefix} ✅ Estimate updated. TxnID: ${txnId}`);

  await QbSyncLogger.complete(logId, {
    qbTxnId: txnId,
    qbRefNumber: refNumber,
    qbOperationId: asyncData.operationId,
    message: `Estimate re-synced — TxnID: ${txnId}${refNumber ? `, Ref: ${refNumber}` : ""}`,
  });

  return {
    enabled: true,
    operationId: asyncData.operationId,
    txnId,
    refNumber,
  };
}

// ─── 6. Deactivate Estimate (Draft Order Deleted) ──────────────────────────────

/**
 * Called when a Draft Order is deleted in Medusa Admin.
 * Marks the corresponding QB Estimate as inactive (Active checkbox = false).
 * This removes it from active QB lists without destroying the history.
 */
export async function processDeactivateEstimateInQb(draft: {
  draftOrderId: string;
  estimateTxnId: string; // existing qb_estimate_txn_id from order metadata
  estimateRef?: string; // human-readable reference (for logging)
  medusaRefNumber?: string; // display ref for pipeline UI (e.g. "E1271")
}): Promise<{
  enabled: boolean;
  operationId?: string;
  txnId?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const guard = await runGuards();
  if (!guard.pass) return { enabled: false, skipped: true };

  const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]";
  console.log(
    `${prefix} Deactivating Estimate ${draft.estimateTxnId} (Ref: ${draft.estimateRef || "?"}) for draft order ${draft.draftOrderId}...`
  );

  const logId = await QbSyncLogger.start({
    operation: "estimate",
    draftOrderId: draft.draftOrderId,
    eventType: "draft_order.voided",
    triggeredBy: "manual",
    message: `Voiding Estimate ${draft.estimateRef || draft.estimateTxnId} — draft order canceled`,
  });

  // Pre-flight pipeline row: pending
  try {
    await writePipelineRow({
      orderId: draft.draftOrderId,
      step: "void_estimate",
      status: "pending",
      qbTxnId: draft.estimateTxnId,
      qbRefNumber: draft.estimateRef ?? null,
      medusaRefNumber: draft.medusaRefNumber ?? draft.estimateRef ?? null,
    });
  } catch (pErr: any) {
    console.warn(
      `${prefix} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  // Use cached EditSequence if available — skips a round-trip GET to QB
  const cachedEditSeqEntry = await getCachedEditSequence(
    "estimate",
    draft.estimateTxnId
  ).catch(() => null);
  const cachedEditSeq = cachedEditSeqEntry?.editSeq ?? null;
  if (cachedEditSeq) {
    console.log(
      `${prefix} Using cached EditSequence for estimate ${draft.estimateTxnId}`
    );
  }

  const result = await deactivateEstimateInQb(
    draft.estimateTxnId,
    cachedEditSeq ?? undefined
  );

  if (!result.success) {
    console.error(`[QB] ❌ Failed to deactivate Estimate: ${result.error}`);
    await QbSyncLogger.fail(
      logId,
      result.error || "Estimate deactivation failed"
    );
    try {
      await writePipelineRow({
        orderId: draft.draftOrderId,
        step: "void_estimate",
        status: "failed",
        qbTxnId: draft.estimateTxnId,
        qbRefNumber: draft.estimateRef ?? null,
        medusaRefNumber: draft.medusaRefNumber ?? draft.estimateRef ?? null,
        error: result.error ?? "Estimate deactivation failed",
      });
    } catch (pErr: any) {
      console.warn(
        `${prefix} ⚠️ Could not write failed pipeline row: ${pErr.message}`
      );
    }
    return { enabled: true, error: result.error };
  }

  const asyncData = result.data!;
  console.log(
    `${prefix} ✅ Estimate deactivation queued. OperationID: ${asyncData.operationId}`
  );

  // Submitted pipeline row
  try {
    await writePipelineRow({
      orderId: draft.draftOrderId,
      step: "void_estimate",
      status: "submitted",
      bridgeOpId: asyncData.operationId ?? null,
      qbTxnId: draft.estimateTxnId,
      qbRefNumber: draft.estimateRef ?? null,
      medusaRefNumber: draft.medusaRefNumber ?? draft.estimateRef ?? null,
    });
  } catch (pErr: any) {
    console.warn(
      `${prefix} ⚠️ Could not write submitted pipeline row: ${pErr.message}`
    );
  }

  let txnId = asyncData.txnId || draft.estimateTxnId;

  if (asyncData.operationId !== "DRY_RUN") {
    try {
      const pollResult = await pollOperationResult(asyncData.operationId);
      if (pollResult.txnId) txnId = pollResult.txnId;
    } catch (pollErr: any) {
      const isFailed = pollErr.message?.toLowerCase().includes("failed");
      if (isFailed) {
        // Real QB error (e.g. error 3175 — record open/locked in QB Desktop)
        console.error(
          `${prefix} ❌ Estimate deactivation failed: ${pollErr.message}`
        );
        await QbSyncLogger.fail(logId, pollErr.message);
        try {
          await writePipelineRow({
            orderId: draft.draftOrderId,
            step: "void_estimate",
            status: "failed",
            qbTxnId: draft.estimateTxnId,
            qbRefNumber: draft.estimateRef ?? null,
            medusaRefNumber: draft.medusaRefNumber ?? draft.estimateRef ?? null,
            error: pollErr.message,
          });
        } catch {
          /* non-critical */
        }
        return { enabled: true, error: pollErr.message };
      }
      // Polling timeout — deactivation was queued but QB hasn't responded yet (non-fatal)
      console.warn(
        `${prefix} ⚠️ Deactivation polling timeout (non-fatal): ${pollErr.message}`
      );
    }
  }

  console.log(`${prefix} ✅ Estimate deactivated. TxnID: ${txnId}`);

  await QbSyncLogger.complete(logId, {
    qbTxnId: txnId,
    qbOperationId: asyncData.operationId,
    message: `Estimate deactivated (Active=false) — TxnID: ${txnId}`,
  });

  return { enabled: true, operationId: asyncData.operationId, txnId };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getDateString(date?: string | Date): string {
  if (date) {
    return new Date(date).toISOString().split("T")[0] as string;
  }
  return new Date().toISOString().split("T")[0] as string;
}
