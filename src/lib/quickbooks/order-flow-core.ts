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

import { computeBatchDay, getBatchCutoff } from "../finance/batch-day";
import { buildQbCustomerName } from "./build-customer-name";
import { createSalesReceiptInQb } from "./client/sales-receipts";
import { getFloat } from "./handlers/utils";
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
const NON_SITE_QB_ITEM_TYPES = new Set([
  "Service",
  "NonInventory",
  "NonInventoryPart",
  "OtherCharge",
  "Discount",
  "Subtotal",
  "Payment",
  "SalesTax",
]);

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
    product?: {
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

type ProductQbInfo =
  | boolean
  | {
      taxable: boolean;
      metadata?: Record<string, any>;
    };

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
/**
 * Resolves the productId → taxable map for a set of order items.
 * Reads `product.taxable` directly via raw SQL because the column is added
 * by a custom migration outside Medusa's entity model.
 *
 * Pass the returned map as the third arg to buildQbItems so the bridge can
 * emit per-line `<SalesTaxCodeRef>Non</...>` for non-taxable lines.
 */
/**
 * Resolves the order-line-id → taxable map for a set of order items.
 *
 * Reads `order_line_item.taxable`, the SNAPSHOT the DB trigger seeds from
 * `product.taxable` when the line is created. Taxability itself is a product
 * attribute — nothing in the POS can set it per line — so this map is not a
 * second opinion, it is the value as it stood when the document was written.
 *
 * It is still needed alongside the product map, for two reasons. A snapshot can
 * differ from today's catalog (8 lines predate the trigger and carry the column
 * default under a non-taxable product), and when we send no per-line tax code
 * at all QuickBooks falls back to the tax status stored on its own item, which
 * we do not control from here. Combined by AND with the product flag, so the
 * result is exempt whenever either source says exempt.
 *
 * Pass the returned map as the fourth arg to buildQbItems.
 */
export async function resolveLineTaxableMap(
  pg: any,
  items: MedusaOrderForQb["items"]
): Promise<Record<string, boolean>> {
  const lineIds = Array.from(
    new Set((items || []).map((i) => (i as any).id).filter(Boolean) as string[])
  );
  if (lineIds.length === 0) return {};
  try {
    const r = await pg.raw(
      `SELECT id, taxable FROM order_line_item WHERE id = ANY(?::text[])`,
      [lineIds]
    );
    return Object.fromEntries(
      (r.rows ?? []).map((row: any) => [row.id, row.taxable !== false])
    );
  } catch (e: any) {
    // Rethrow. An empty map here reads downstream as "no line is exempt", and
    // for a document that carries `salesTaxCode` the bridge answers a blank flag
    // with its `Tax` branch — so a transient DB error would write a taxable line
    // into QuickBooks where an exempt one belongs. That is money, so the caller
    // must fail rather than send a payload built from a failed read.
    throw new Error(
      `could not read per-line taxable flags for the QB payload: ${e?.message ?? e}`
    );
  }
}

export async function resolveProductTaxableMap(
  pg: any,
  items: MedusaOrderForQb["items"]
): Promise<Record<string, ProductQbInfo>> {
  const productIds = Array.from(
    new Set(
      (items || [])
        .map((i) => (i.variant as any)?.product_id ?? (i as any).product_id)
        .filter(Boolean) as string[]
    )
  );
  if (productIds.length === 0) return {};
  try {
    const r = await pg.raw(
      `SELECT id, taxable, metadata FROM product WHERE id = ANY(?::text[])`,
      [productIds]
    );
    return Object.fromEntries(
      (r.rows ?? []).map((row: any) => [
        row.id,
        {
          taxable: row.taxable !== false,
          metadata: row.metadata ?? {},
        },
      ])
    );
  } catch {
    return {};
  }
}

export function buildQbItems(
  items: MedusaOrderForQb["items"],
  _metadata?: Record<string, any>,
  /**
   * Optional map of Medusa product_id → taxable. When provided, each emitted
   * QB line item carries `taxable: false` if the product is non-taxable.
   * The bridge consults this flag to emit `<SalesTaxCodeRef>Non</...>` per
   * line, so QB does not tax services / labor lines like INSTALL.
   * Default (undefined) preserves prior behavior — every line is taxable.
   */
  productTaxableMap?: Record<string, ProductQbInfo>,
  /**
   * Optional map of order_line_item.id → taxable (the PER-LINE exemption).
   * Combined with the product map by OR: a line is non-taxable when EITHER
   * says so. Never the other way round — a line-level `true` must not be able
   * to re-tax a product QuickBooks holds as non-taxable, or this map could
   * turn an existing `Non` into `Tax` on a *Mod. Monotonic toward exempt.
   */
  lineTaxableMap?: Record<string, boolean>
): QbOrderItem[] {
  const productLines = (items || [])
    .filter((item) => item.variant?.metadata?.quickbooks_id)
    .map((item) => {
      // Coerce numerics up-front. query.graph can hand back computed money
      // fields (unit_price/subtotal) as STRINGS or BigNumber-shaped objects
      // ({ numeric_, raw_ }) rather than plain numbers — calling .toFixed()
      // on those crashes ("item.subtotal.toFixed is not a function", e.g.
      // Estimate E2070). getFloat() normalizes all three shapes to a number.
      const unitPrice = getFloat(item.unit_price);
      const quantity = getFloat(item.quantity);
      const subtotal =
        item.subtotal === undefined || item.subtotal === null
          ? undefined
          : getFloat(item.subtotal);
      // Use discounted unit price if item has adjustments (subtotal < unit_price * qty).
      // Both item-level discounts (per-item promotions) and order-level distributed discounts
      // are reflected here. Price is always per-unit in dollars for QB.
      const originalTotal = unitPrice * quantity;
      const hasLineDiscount =
        subtotal !== undefined && subtotal < originalTotal && subtotal > 0;
      const effectiveUnitPrice = hasLineDiscount
        ? Number((subtotal! / quantity).toFixed(2)) // discounted subtotal ÷ qty (display rate only)
        : unitPrice; // no discount → original unit price
      // Send the EXACT line total as Amount. The bridge emits <Amount> and
      // omits <Rate>, so QB honors this total and back-computes the per-unit
      // rate for display. Deriving amount from the ROUNDED effectiveUnitPrice
      // drifts from Medusa whenever a per-item % discount yields fractional
      // cents (65.99 × 0.8 = 52.792 → rate 52.79 → 52.79 × 20 = 1055.80, but
      // Medusa's true line total is 1055.84). Using item.subtotal keeps them
      // identical. Non-discounted lines fall back to unit_price × qty (exact).
      const lineAmount = hasLineDiscount
        ? Number(subtotal!.toFixed(2))
        : Number((effectiveUnitPrice * quantity).toFixed(2));
      // Service / non-inventory items must NOT carry InventorySiteRef (QB
      // error 3140). Flag explicitly via variant metadata so the bridge can
      // skip the tag on both *Add and *Mod operations.
      const productIdMedusa =
        (item.variant as any)?.product_id ?? (item as any).product_id;
      const productInfo = productIdMedusa
        ? productTaxableMap?.[productIdMedusa]
        : undefined;
      const productMetadata =
        (item.product as any)?.metadata ??
        (typeof productInfo === "object" ? productInfo.metadata : undefined) ??
        {};
      const qbItemType =
        item.variant?.metadata?.qb_item_type ?? productMetadata.qb_item_type;
      const isNoSiteItem = !!(
        item.variant?.metadata?.quickbooks_is_service === true ||
        item.variant?.metadata?.quickbooks_is_service === "true" ||
        item.variant?.metadata?.quickbooks_no_site === true ||
        item.variant?.metadata?.quickbooks_no_site === "true" ||
        productMetadata.quickbooks_is_service === true ||
        productMetadata.quickbooks_is_service === "true" ||
        productMetadata.quickbooks_no_site === true ||
        productMetadata.quickbooks_no_site === "true" ||
        (typeof qbItemType === "string" &&
          NON_SITE_QB_ITEM_TYPES.has(qbItemType))
      );
      // Resolve per-line tax flag from the optional product map. When the
      // map is missing or has no entry for this product, default to taxable
      // (true) — preserves legacy behavior.
      const productSaysTaxable =
        productTaxableMap && productIdMedusa
          ? typeof productInfo === "object"
            ? productInfo.taxable !== false
            : productInfo !== false
          : true;
      // The per-line flag can only REMOVE tax, never add it (see lineTaxableMap
      // doc above). An absent entry means "no opinion", not "taxable".
      const lineSaysTaxable = lineTaxableMap?.[(item as any)?.id] !== false;
      const lineTaxable = isNoSiteItem
        ? false
        : productSaysTaxable && lineSaysTaxable;
      return {
        _sortOrder:
          typeof item.metadata?.sort_order === "number"
            ? item.metadata.sort_order
            : 9999,
        qbItem: {
          productId: item.variant!.metadata!.quickbooks_id as string,
          quantity,
          price: effectiveUnitPrice,
          amount: lineAmount,
          unitOfMeasure:
            (item.variant?.metadata?.quickbooks_uom as string) || undefined,
          desc: sanitizeForQb(
            item.metadata?.sales_description
              ? String(item.metadata.sales_description)
              : `${item.title || item.product_title || ""}${item.variant?.sku ? ` (${item.variant.sku})` : ""}`
          ),
          ...(typeof qbItemType === "string" ? { qbItemType } : {}),
          ...(isNoSiteItem ? { noSite: true } : {}),
          ...(lineTaxable ? {} : { taxable: false }),
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
/**
 * Computes the effective order-level discount in dollars, robust to Medusa
 * fields not being populated.
 *
 * Tries (in order):
 *   1. order.discount_total — Medusa's aggregated discount field
 *   2. Sum of order.items[].adjustments[].amount — per-item promotion
 *      adjustments (Medusa stores POS promotion codes like CPOS-PCT-XXXX
 *      as line-item adjustments; discount_total can lag or return 0).
 *   3. order.metadata.computed_discount — POS-side snapshot at placement
 *
 * Returns the FIRST source that yields a positive number; 0 if none do.
 *
 * Why: in production we observed orders (e.g. order 1350 / SO 6295) where
 * a 12% promotion existed as 7 per-item adjustments summing to $875.33,
 * but order.discount_total returned 0 — so handlers that gate on
 * discount_total alone silently dropped the Discount line in QB.
 */
/**
 * El descuento de orden que se le MANDA a QuickBooks, en la única convención
 * que reproduce lo que QB terminó facturando: **redondeado POR LÍNEA** y
 * después sumado.
 *
 * Por qué importa acá y no es cosmético: QB no calcula este número, se lo
 * mandamos hecho — `buildQbOrderDiscountLines` manda el monto exacto en dólares
 * justamente "so QB doesn't recalculate via %". Así que la cifra que sale de
 * esta función ES el descuento del documento contable.
 *
 * Esta función alimenta los caminos que NO tienen un `pos_invoice` del que
 * copiar: Estimate (`qb-draft-order-subscriber`), Sales Order
 * (`handle-order-placed`) y los fallbacks de invoice y sales receipt. Los que sí
 * lo tienen usan el snapshot, que ya venía per-línea — de ahí que Invoice 19614
 * fuera correcta mientras el resto podía no serlo.
 *
 * Medido en sandbox contra 7 documentos reales con descuento
 * (`src/scripts/checks/probe-qb-discount-resolver.ts`): la convención agregada
 * se desviaba en E2146 (−0.04), E2607 (+0.01) y S11242 (+0.01).
 *
 * NO deduplica adjustments por versión, y es correcto: se verificó que
 * `query.graph` ya los entrega acotados a la versión vigente — S11242 tiene 5
 * versiones y 3 filas por línea en SQL crudo, y por acá llegan 11 filas que
 * suman una vez. `loadOrderMoneyBase` sí deduplica porque lee SQL directo, sin
 * ese filtro.
 */
export function getEffectiveOrderDiscount(order: any): number {
  // PRIMERO los adjustments, porque son la fuente POR LÍNEA.
  //
  // `discount_total` iba primero y esa precedencia es la que hacía fallar el
  // caso real: Medusa lo calcula como un agregado (S11242: 138.0792), así que
  // redondearlo da 138.08 y nunca se llega a mirar las líneas. QuickBooks
  // facturó 138.07 en la Invoice 19614 y el `pos_invoice` del cliente dice lo
  // mismo. Un agregado NO PUEDE expresar el redondeo por línea: no es que esté
  // mal calculado, es que perdió la información antes de llegar acá.
  //
  // El orden nuevo también alinea este resolver con `loadOrderMoneyBase`, que
  // ya derivaba el total del documento desde los adjustments. Cuando los dos
  // leían fuentes distintas, el total guardado y el descuento enviado a QB
  // podían discrepar sin que nada fallara.
  const items = Array.isArray(order?.items) ? order.items : [];
  let cents = 0;
  for (const it of items) {
    const adjs = Array.isArray(it?.adjustments) ? it.adjustments : [];
    // La línea se acumula sin redondear y se redondea UNA vez, igual que
    // `loadOrderMoneyBase`: varias filas de adjustment sobre la misma línea son
    // partes de un mismo descuento de línea, no líneas distintas.
    let lineDollars = 0;
    for (const a of adjs) {
      if (a?.deleted_at) continue;
      const amt = Number(a?.amount);
      if (Number.isFinite(amt) && amt > 0) lineDollars += amt;
    }
    cents += Math.round(lineDollars * 100);
  }
  if (cents > 0) return cents / 100;

  // Sin adjustments, `discount_total` es lo mejor que hay: un descuento que
  // nunca se distribuyó a las líneas. Acá el agregado no pierde nada porque no
  // existe un desglose que respetar.
  const fromTotal = Number(order?.discount_total);
  if (Number.isFinite(fromTotal) && fromTotal > 0) return round2(fromTotal);

  const fromMetadata = Number(order?.metadata?.computed_discount);
  return Number.isFinite(fromMetadata) && fromMetadata > 0
    ? round2(fromMetadata)
    : 0;
}

/** Redondeo a centavos por el entero, no por EPSILON. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
    qbTaxItemListid?: string;
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
        qbTaxItemListid: options?.qbTaxItemListid,
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
        qbTaxItemListid: options?.qbTaxItemListid,
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
  /** YYYY-MM-DD business date of the real payment (received_at/created_at in
   * the POS). Sent as QB <TxnDate> so the payment lands on the day it was
   * taken, immune to QB machine clock drift and pipeline latency. */
  date?: string;
  /**
   * Dedupe key for this ADD, forwarded to the bridge as `Idempotency-Key`.
   * OPT-IN: only pass one that is 1:1 with the QB document you intend to
   * create (e.g. `payment:<cpay_id>`). A key shared by two legitimately
   * distinct payments makes the bridge swallow the second one — missing money
   * in QB, which is worse than the duplicate it prevents. See
   * receivePaymentInQb for the full rationale.
   */
  idempotencyKey?: string;
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

  const result = await receivePaymentInQb(
    {
      customerId: capture.qbCustomerId,
      amount: amountDollars,
      date: capture.date,
      paymentMethod: capture.paymentMethod,
      memo: paymentMemo,
      autoApply: false,
    },
    capture.idempotencyKey
      ? { idempotencyKey: capture.idempotencyKey }
      : undefined
  );

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
  qbTaxItemListid?: string; // QB SalesTaxItem ListID — preferred over salesTaxCode
  salesRep?: string;
  refNumber?: string; // Custom Invoice Number
  memo?: string;
  /**
   * Source date for the QB <TxnDate>. Should be the fulfillment/pos_invoice
   * created_at — NOT "now" — so retries after QB bridge outages still book
   * to the original business day. When omitted, QB will default to today.
   */
  invoiceDate?: string | Date | null;
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
    // TxnDate = merchant batch day: after the 18:45 ET cutoff the sale belongs
    // to the NEXT day's batch (matches the processor's deposits). Deterministic
    // from the invoice timestamp, so retries/resubmits land on the same day.
    date: computeBatchDay(invoice.invoiceDate ?? null, await getBatchCutoff()),
    LinkToTxnID: invoice.qbSoTxnId,
    items: invoice.prebuiltItems,
    salesTaxCode: invoice.salesTaxCode,
    qbTaxItemListid: invoice.qbTaxItemListid,
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
 * Canonical POS → QB PaymentMethod resolution lives in
 * `./payment-method-sanitizer.ts` — the single source of truth shared by
 * every QB handler (ReceivePayment + SalesReceipt). Do not re-inline this
 * mapping here; add brands/aliases to the sanitizer instead.
 */
import {
  sanitizeToQbPaymentMethod,
  QB_PAYMENT_METHOD_NAMES as _QB_PAYMENT_METHOD_NAMES,
} from "./payment-method-sanitizer";

export const QB_PAYMENT_METHOD_NAMES = _QB_PAYMENT_METHOD_NAMES;

function mapPaymentMethodToQb(method: string | undefined): string | undefined {
  return sanitizeToQbPaymentMethod(method);
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
  qbTaxItemListid?: string;
  salesRep?: string;
  refNumber?: string;
  memo?: string;
  /**
   * Source date for the QB <TxnDate>. Should be the pos_invoice created_at
   * (cashier close time) — NOT "now" — so retries after QB bridge outages
   * still book to the original business day.
   */
  receiptDate?: string | Date | null;
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
    // TxnDate = merchant batch day (same cutoff rule as Invoice/ReceivePayment).
    date: computeBatchDay(receipt.receiptDate ?? null, await getBatchCutoff()),
    items: receipt.prebuiltItems || [],
    salesTaxCode: receipt.salesTaxCode,
    qbTaxItemListid: receipt.qbTaxItemListid,
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
  qbTaxItemListid?: string;
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
    ...(draft.qbTaxItemListid
      ? { qbTaxItemListid: draft.qbTaxItemListid }
      : {}),
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
  qbTaxItemListid?: string; // QB SalesTaxItem ListID — preferred over salesTaxCode
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
    ...(draft.qbTaxItemListid
      ? { qbTaxItemListid: draft.qbTaxItemListid }
      : {}),
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

// QB document dates should reflect the local business calendar of the
// store, not UTC. Florida is America/New_York; override via env if the
// company books in another timezone.
const QB_DOC_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York";

/**
 * Returns YYYY-MM-DD for the given instant in the store's local timezone.
 * Falls back to "today" only when no source date is supplied. Callers that
 * represent a real business event (order/fulfillment/pos_invoice) MUST pass
 * the source date so QB <TxnDate> stays stable across retries.
 */
export function getBusinessDateString(date?: string | Date | null): string {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: QB_DOC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}

// Thin wrapper so existing SO/Estimate call sites keep compiling.
// Prefer getBusinessDateString in new code.
function getDateString(date?: string | Date): string {
  return getBusinessDateString(date);
}
