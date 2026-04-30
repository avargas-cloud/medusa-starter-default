export const LOG_PREFIX = "[QB-ORDER]";

/** Helper: safely extract floating point numbers from Medusa BigNumber objects */
export const getFloat = (val: any) => Number(val?.numeric_ ?? val) || 0;

// Sales Channel IDs from .env
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? "";

/** Returns true if the order was placed through the POS sales channel */
export function isPosOrder(order: any): boolean {
  if (POS_CHANNEL_ID && order.sales_channel_id === POS_CHANNEL_ID) return true;
  if (order.metadata?.pos_created === true) return true;
  return false;
}

/**
 * In-memory mutex for order.placed idempotency.
 */
export const processingOrders = new Set<string>();

// Lightweight QB config reader
export function getQbConfig(): {
  shippingItemId: string;
  defaultSalesTaxCode: string;
  exemptSalesTaxCode: string;
  taxItemListidTaxed?: string;
  taxItemListidExempt?: string;
} {
  return {
    shippingItemId: process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
    defaultSalesTaxCode: process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
    exemptSalesTaxCode: process.env.QB_EXEMPT_SALES_TAX_CODE || "Exempt",
    taxItemListidTaxed: process.env.QB_TAX_ITEM_LISTID_TAXED || undefined,
    taxItemListidExempt: process.env.QB_TAX_ITEM_LISTID_EXEMPT || undefined,
  };
}
