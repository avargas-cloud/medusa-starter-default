import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * Propagate a variant SKU edit down to its linked inventory_item(s).
 *
 * Medusa keeps TWO sku columns: product_variant.sku (what the edit modal's
 * "Internal SKU" field writes) and inventory_item.sku (set at creation, never
 * touched by updateProductVariantsWorkflow). The POS inventory MeiliSearch doc
 * is keyed by inventory_item.id and prefers inventory_item.sku, so a renamed
 * variant SKU kept showing the OLD value on the cashier list until both columns
 * matched. This step closes that gap at the source.
 */
export type SyncInventoryItemSkuInput = {
  /** Only entries with a non-empty `sku` are applied. */
  variants: Array<{ variant_id?: string; sku?: string }>;
};

export const syncInventoryItemSkuStep = createStep(
  "sync-inventory-item-sku-step",
  async (input: SyncInventoryItemSkuInput, { container }) => {
    const targets = (input.variants ?? []).filter(
      (v): v is { variant_id: string; sku: string } =>
        !!v.variant_id &&
        typeof v.sku === "string" &&
        v.sku.trim().length > 0
    );
    if (targets.length === 0) {
      return new StepResponse({ updated: 0 }, null);
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const inventoryModule = container.resolve(Modules.INVENTORY) as any;
    const logger = container.resolve("logger");

    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "sku", "inventory_items.inventory_item_id"],
      filters: { id: targets.map((t) => t.variant_id) } as any,
    });

    const skuByVariant = new Map(targets.map((t) => [t.variant_id, t.sku]));

    let updated = 0;
    for (const variant of (variants as any[]) ?? []) {
      const desiredSku = skuByVariant.get(variant.id);
      if (!desiredSku) continue;
      for (const link of variant.inventory_items ?? []) {
        const invId = link?.inventory_item_id;
        if (!invId) continue;
        try {
          await inventoryModule.updateInventoryItems({
            id: invId,
            sku: desiredSku,
          });
          updated++;
        } catch (e: any) {
          logger.warn(
            `[sync-inventory-item-sku] could not update inventory_item ${invId} → ${desiredSku}: ${e.message}`
          );
        }
      }
    }

    return new StepResponse({ updated }, null);
  }
);
