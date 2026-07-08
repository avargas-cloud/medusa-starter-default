export const LOG_PREFIX = "[QB-ORDER]";

/** Helper: safely extract floating point numbers from Medusa BigNumber objects */
export const getFloat = (val: any) => Number(val?.numeric_ ?? val) || 0;

/**
 * Consume the stored net closest to `computedNet` from `bucket`, REMOVING it in place
 * (mutates the array). Returns undefined if the bucket is empty/absent.
 *
 * Frozen invoice nets are keyed by `${variant|sku}|${grossCents}`; two lines of the
 * SAME variant at the SAME list price but DIFFERENT per-line discount (e.g. one ESPDO
 * at $60.75 and a second ESPDO at $60.75 −50% = $30.38) collapse to one key. A scalar
 * lookup let the second overwrite the first, so BOTH lines read the discounted net and
 * QB got both at $30.38 (order 2450, Inv 18973 → $30.37 short → apply_payment QB 3210).
 * Storing a multiset and consuming the CLOSEST net to each line's own computed net keeps
 * both lines distinct regardless of the (non-deterministic) snapshot row order.
 */
export function consumeClosestNet(
  bucket: number[] | undefined,
  computedNet: number
): number | undefined {
  if (!bucket || bucket.length === 0) return undefined;
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < bucket.length; i++) {
    const candidate = bucket[i];
    if (candidate === undefined) continue;
    const diff = Math.abs(candidate - computedNet);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bucket.splice(bestIdx, 1)[0];
}

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
