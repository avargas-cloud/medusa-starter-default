import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { USA_LOC } from "../../../lib/locations";

export type EnsureMiamiLevelsInput = {
  /**
   * Product id just created by createProductsWorkflow. We resolve each
   * variant's linked inventory_item through query.graph and create an
   * inventory_level at the Miami warehouse (stocked 0) when none exists.
   *
   * Without this, createProductsWorkflow leaves managed variants with an
   * inventory_item but NO level at any location, which makes the item
   * unstockable — receiving a PO against it throws "Inventory level ... not
   * found" (production incident 2026-05-22).
   */
  product_id: string;
  /** Only inventory-type products manage stock; service items are skipped. */
  manage_inventory: boolean;
};

export type EnsureMiamiLevelsOutput = {
  created_inventory_item_ids: string[];
  already_present: number;
};

export const ensureMiamiLevelsStep = createStep(
  "ensure-miami-levels-step",
  async (input: EnsureMiamiLevelsInput, { container }) => {
    if (!input.product_id || !input.manage_inventory) {
      return new StepResponse(
        { created_inventory_item_ids: [], already_present: 0 },
        null
      );
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const inventoryModule = container.resolve(Modules.INVENTORY) as {
      listInventoryLevels: (
        filters: Record<string, unknown>,
        options?: { take?: number }
      ) => Promise<Array<{ inventory_item_id: string }>>;
      createInventoryLevels: (
        data: Array<{
          inventory_item_id: string;
          location_id: string;
          stocked_quantity?: number;
        }>
      ) => Promise<unknown>;
    };
    const logger = container.resolve("logger");

    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "variants.id", "variants.inventory_items.inventory_item_id"],
      filters: { id: input.product_id } as Record<string, unknown>,
    });

    const product = (products as Array<Record<string, unknown>>)[0];
    if (!product) {
      logger.warn(`[ensure-miami-levels] product ${input.product_id} not found`);
      return new StepResponse(
        { created_inventory_item_ids: [], already_present: 0 },
        null
      );
    }

    const invIds = new Set<string>();
    for (const variant of (product.variants as Array<Record<string, unknown>>) ??
      []) {
      for (const link of (variant.inventory_items as Array<{
        inventory_item_id?: string;
      }>) ?? []) {
        if (link.inventory_item_id) invIds.add(link.inventory_item_id);
      }
    }

    if (invIds.size === 0) {
      return new StepResponse(
        { created_inventory_item_ids: [], already_present: 0 },
        null
      );
    }

    // Which of these already have a Miami level? Skip those (idempotent).
    const existing = await inventoryModule.listInventoryLevels(
      {
        inventory_item_id: Array.from(invIds),
        location_id: USA_LOC,
      },
      { take: invIds.size }
    );
    const haveLevel = new Set(existing.map((l) => l.inventory_item_id));

    const toCreate = Array.from(invIds).filter((id) => !haveLevel.has(id));
    const createdIds: string[] = [];

    for (const invId of toCreate) {
      try {
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: invId,
            location_id: USA_LOC,
            stocked_quantity: 0,
          },
        ]);
        createdIds.push(invId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(
          `[ensure-miami-levels] could not create level for inventory_item ${invId}: ${message}`
        );
      }
    }

    logger.info(
      `[ensure-miami-levels] product=${input.product_id} created=${createdIds.length} already=${haveLevel.size}`
    );

    return new StepResponse(
      {
        created_inventory_item_ids: createdIds,
        already_present: haveLevel.size,
      },
      null
    );
  }
);
