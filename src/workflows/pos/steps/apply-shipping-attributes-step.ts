import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

export type ApplyShippingAttributesInput = {
  /**
   * Product id just created by createProductsWorkflow. We'll resolve each
   * variant's linked inventory_item through query.graph and update the
   * weight/length/width/height columns directly — the same columns the
   * admin's "Shipping Attributes" widget reads on the inventory-item page
   * and the UPS rate quoter consumes at checkout.
   */
  product_id: string;
  /** lbs — null means the field was not provided by the caller */
  weight_lbs?: number | null;
  /** inches */
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
};

export type ApplyShippingAttributesOutput = {
  updated_inventory_item_ids: string[];
  skipped_variants: number;
};

const hasAnyValue = (i: ApplyShippingAttributesInput) =>
  [i.weight_lbs, i.length_in, i.width_in, i.height_in].some(
    (v) => v !== undefined && v !== null
  );

export const applyShippingAttributesStep = createStep(
  "apply-shipping-attributes-step",
  async (input: ApplyShippingAttributesInput, { container }) => {
    if (!input.product_id || !hasAnyValue(input)) {
      return new StepResponse(
        { updated_inventory_item_ids: [], skipped_variants: 0 },
        null
      );
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const inventoryModule = container.resolve(Modules.INVENTORY) as any;
    const logger = container.resolve("logger");

    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "variants.id",
        "variants.sku",
        "variants.inventory_items.inventory_item_id",
      ],
      filters: { id: input.product_id } as any,
    });

    const product = (products as any[])[0];
    if (!product) {
      logger.warn(
        `[apply-shipping-attributes] product ${input.product_id} not found`
      );
      return new StepResponse(
        { updated_inventory_item_ids: [], skipped_variants: 0 },
        null
      );
    }

    const patch: Record<string, number> = {};
    if (input.weight_lbs !== undefined && input.weight_lbs !== null)
      patch.weight = input.weight_lbs;
    if (input.length_in !== undefined && input.length_in !== null)
      patch.length = input.length_in;
    if (input.width_in !== undefined && input.width_in !== null)
      patch.width = input.width_in;
    if (input.height_in !== undefined && input.height_in !== null)
      patch.height = input.height_in;

    const updatedIds: string[] = [];
    let skipped = 0;

    for (const variant of product.variants ?? []) {
      const invLinks = variant.inventory_items ?? [];
      if (invLinks.length === 0) {
        skipped++;
        continue;
      }
      for (const link of invLinks) {
        const invId = link.inventory_item_id;
        if (!invId) {
          skipped++;
          continue;
        }
        try {
          await inventoryModule.updateInventoryItems({
            id: invId,
            ...patch,
          });
          updatedIds.push(invId);
        } catch (e: any) {
          logger.warn(
            `[apply-shipping-attributes] could not update inventory_item ${invId}: ${e.message}`
          );
        }
      }
    }

    logger.info(
      `[apply-shipping-attributes] product=${input.product_id} updated=${updatedIds.length} skipped=${skipped}`
    );

    return new StepResponse(
      {
        updated_inventory_item_ids: updatedIds,
        skipped_variants: skipped,
      },
      null
    );
  }
);
