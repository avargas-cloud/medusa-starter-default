/**
 * vendor-credit-inventory-site.ts
 *
 * Which QuickBooks InventorySite a vendor credit's item line hits.
 *
 * Why this exists (2026-09-18): VC-1002 (Luxury LED, 6 × SUP-MDA-300-24
 * returned from PO-1163) reached QuickBooks WITHOUT `<InventorySiteRef>`, so
 * with Advanced Inventory on, QB booked the −6 against its default
 * "Unspecified Site" while the item receipt had put the +6 in "Principal
 * Warehouse" — total 0, per-site +6/−6, and the warehouse report never showed
 * the return. Every other document that moves stock (item receipt, invoice,
 * credit memo, inventory adjustment) already sends the site; the vendor
 * credit builders were the only ones that did not.
 *
 * Resolution mirrors the bridge's `itemReceipt.ts` and the inventory
 * adjustment poller: `stock_location.metadata.qb_inventory_site_list_id` of
 * the credit's PO location when set, otherwise Principal Warehouse. Service /
 * non-inventory items get NO site at all — QB rejects `InventorySiteRef` on
 * them with error 3140 (same guard as `order-flow-core.ts`).
 */

import type { PurchaseDependencyKnex } from "./qb-purchase-dependency-chain";

/** Principal Warehouse (Ecopowertech Miami) — same fallback as every bridge builder. */
export const DEFAULT_QB_INVENTORY_SITE_LIST_ID = "80000001-1331053531";

/** QB item types that never carry an InventorySiteRef (error 3140). Mirrors `order-flow-core.ts`. */
const NON_SITE_QB_ITEM_TYPES = new Set([
  "Service",
  "NonInventory",
  "NonInventoryPart",
  "OtherCharge",
  "Discount",
  "Payment",
  "Subtotal",
  "SalesTax",
  "SalesTaxGroup",
  "Group",
  "FixedAsset",
]);

export interface VendorCreditLineSiteInput {
  /** `stock_location.metadata.qb_inventory_site_list_id` of the credit's PO location; null/undefined = no override. */
  locationSiteListId: string | null | undefined;
  /** `product_variant.metadata.qb_item_type` (or the product's). */
  qbItemType?: string | null;
  quickbooksIsService?: boolean | string | null;
  quickbooksNoSite?: boolean | string | null;
}

const isTruthyFlag = (v: boolean | string | null | undefined): boolean =>
  v === true || v === "true";

/**
 * PURE. `null` means "emit no InventorySiteRef" (non-inventory item);
 * otherwise the site ListID the line must carry.
 */
export function resolveVendorCreditLineSite(input: VendorCreditLineSiteInput): string | null {
  if (isTruthyFlag(input.quickbooksIsService) || isTruthyFlag(input.quickbooksNoSite)) {
    return null;
  }
  if (typeof input.qbItemType === "string" && NON_SITE_QB_ITEM_TYPES.has(input.qbItemType)) {
    return null;
  }
  const override = (input.locationSiteListId ?? "").trim();
  return override.length > 0 ? override : DEFAULT_QB_INVENTORY_SITE_LIST_ID;
}

/**
 * Site override of the PO's stock location. `null` when the PO has no
 * location, the location has no override, or `purchaseOrderId` is null (a
 * credit without PO never queries — its product lines, if any legacy ones
 * exist, default to Principal Warehouse).
 */
export async function loadPoLocationSiteListId(
  knex: PurchaseDependencyKnex,
  purchaseOrderId: string | null
): Promise<string | null> {
  if (!purchaseOrderId) return null;
  const result = await knex.raw(
    `SELECT sl.metadata ->> 'qb_inventory_site_list_id' AS qb_inventory_site_list_id
       FROM purchase_order po
       LEFT JOIN stock_location sl
         ON sl.id = po.stock_location_id AND sl.deleted_at IS NULL
      WHERE po.id = ?
      LIMIT 1`,
    [purchaseOrderId]
  );
  const row = (result.rows[0] ?? null) as { qb_inventory_site_list_id: string | null } | null;
  return row?.qb_inventory_site_list_id ?? null;
}
