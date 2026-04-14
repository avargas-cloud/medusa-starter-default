import { DRY_RUN, bridgeFetch } from "./core";
import { QbBridgeResult } from "./types";

/**
 * Reduces QB inventory when an order is placed (immediate deduction per order).
 * This is separate from the periodic Inventory Sync (which handles PO receipts).
 */
export async function adjustInventoryInQb(
  items: Array<{
    listId: string; // QB ListID of the product
    quantity: number; // absolute new quantity (not a delta)
  }>
): Promise<QbBridgeResult> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would adjust inventory for ${items.length} items in QB`
    );
    return { success: true, dryRun: true };
  }

  try {
    await bridgeFetch("POST", "/api/products/sync", {
      items: items.map((i) => ({ ListID: i.listId, quantity: i.quantity })),
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
