import { StepResponse } from "@medusajs/framework/workflows-sdk";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { MedusaError, Modules } from "@medusajs/utils";
import { USA_LOC } from "../../lib/locations";

// Workaround for Medusa's exported types missing the internal hooks:
const hooks = completeCartWorkflow.hooks as any;

/**
 * Hook: validate-web-store-inventory
 *
 * Purpose:
 *   Blocks checkout on the Web Store (ecopowertech.com) when any item
 *   in the cart exceeds available inventory.
 *
 *   The POS channel (pos.ecopowertech.com) is EXEMPT — it can always
 *   proceed with backorder, since store reps can order from suppliers.
 *
 * Sales Channels:
 *   Web Store: sc_01KFH7QCHT364SX242A69ZR435  (Default Sales Channel)
 *   POS:       sc_15154EAF0D194265ADD21AAD2D
 *
 * Env Vars used:
 *   WEB_STORE_SALES_CHANNEL_ID  (fallback to hardcoded default)
 *   POS_SALES_CHANNEL_ID
 */

const WEB_STORE_CHANNEL_ID =
  process.env.WEB_STORE_SALES_CHANNEL_ID ?? "sc_01KFH7QCHT364SX242A69ZR435";

hooks.validate(
  async (
    { cart_id }: { cart_id: string },
    { container }: { container: any }
  ) => {
    const query = container.resolve("query");

    // 1. Fetch cart with sales_channel, items, and variant inventory
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "sales_channel_id",
        "items.*",
        "items.variant.*",
        "items.variant.inventory_items.*",
        "items.variant.inventory_items.inventory.*",
      ],
      filters: { id: cart_id },
    });

    if (!carts.length) {
      console.log(`[inventory-guard] Cart ${cart_id} not found — skipping`);
      return new StepResponse(null);
    }

    const cart = carts[0];

    // 2. Only enforce on Web Store channel
    if (cart.sales_channel_id !== WEB_STORE_CHANNEL_ID) {
      console.log(
        `[inventory-guard] Channel ${cart.sales_channel_id} is POS — backorder ALLOWED, skipping check`
      );
      return new StepResponse(null);
    }

    console.log(
      `[inventory-guard] Web Store cart ${cart_id} — running inventory check (Miami-only)`
    );

    // Collect inventory_item_ids referenced by the cart, then load Miami
    // levels in one shot. China stock is intentionally excluded — web orders
    // ship from Miami only.
    const inventoryItemIds = new Set<string>();
    for (const item of cart.items ?? []) {
      for (const inventoryItem of item.variant?.inventory_items ?? []) {
        if (inventoryItem?.inventory?.id) {
          inventoryItemIds.add(inventoryItem.inventory.id);
        }
      }
    }

    const miamiAvailableMap = new Map<string, number>();
    if (inventoryItemIds.size > 0) {
      const inventoryService: any = container.resolve(Modules.INVENTORY);
      const miamiLevels = await inventoryService.listInventoryLevels(
        {
          location_id: USA_LOC,
          inventory_item_id: Array.from(inventoryItemIds),
        },
        { take: 100000 }
      );
      for (const lev of miamiLevels) {
        const available = Math.max(
          0,
          (lev.stocked_quantity ?? 0) - (lev.reserved_quantity ?? 0)
        );
        miamiAvailableMap.set(lev.inventory_item_id, available);
      }
    }

    const outOfStockItems: string[] = [];

    for (const item of cart.items ?? []) {
      const variantTitle =
        item.title ?? item.variant?.title ?? "Unknown product";
      const requestedQty = item.quantity ?? 0;

      // Sum Miami availability across all inventory items for this variant
      let availableQty = 0;
      for (const inventoryItem of item.variant?.inventory_items ?? []) {
        const id = inventoryItem?.inventory?.id;
        if (!id) continue;
        availableQty += miamiAvailableMap.get(id) ?? 0;
      }

      console.log(
        `[inventory-guard]   "${variantTitle}" → requested: ${requestedQty}, available: ${availableQty}`
      );

      if (requestedQty > availableQty) {
        outOfStockItems.push(
          `"${variantTitle}" (requested ${requestedQty}, only ${availableQty} available)`
        );
      }
    }

    if (outOfStockItems.length > 0) {
      console.log(
        `[inventory-guard] ❌ Blocking checkout — OOS items: ${outOfStockItems.join(", ")}`
      );
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `The following items are out of stock: ${outOfStockItems.join("; ")}. Please remove them from your cart to continue.`
      );
    }

    console.log(`[inventory-guard] ✅ All items in stock — checkout allowed`);
    return new StepResponse(null);
  }
);
