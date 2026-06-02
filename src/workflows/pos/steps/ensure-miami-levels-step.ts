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

type InventoryLink = {
  inventory_item_id?: string | null;
};

type ProductVariant = {
  id?: string | null;
  sku?: string | null;
  title?: string | null;
  inventory_items?: InventoryLink[] | null;
};

type ProductGraphRecord = {
  id?: string | null;
  variants?: ProductVariant[] | null;
};

type InventoryModule = {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string }>>;
  createInventoryItems: (data: {
    sku: string;
    title: string;
    requires_shipping: boolean;
  }) => Promise<{ id: string }>;
  createInventoryLevels: (
    data: Array<{
      inventory_item_id: string;
      location_id: string;
      stocked_quantity?: number;
    }>
  ) => Promise<unknown>;
};

type ProductModule = {
  updateProductVariants: (
    id: string,
    data: { manage_inventory: boolean }
  ) => Promise<unknown>;
};

type RemoteLink = {
  create: (data: Record<string, Record<string, string>>) => Promise<unknown>;
};

const variantLabel = (variant: ProductVariant) =>
  `${variant.sku ?? "no-sku"} (${variant.id ?? "no-id"})`;

export const ensureMiamiLevelsStep = createStep(
  "ensure-miami-levels-step",
  async (input: EnsureMiamiLevelsInput, { container }) => {
    if (!input.manage_inventory) {
      return new StepResponse(
        { created_inventory_item_ids: [], already_present: 0 },
        null
      );
    }

    if (!input.product_id) {
      throw new Error(
        "Cannot initialize Miami inventory levels: product_id is required for Inventory items"
      );
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const inventoryModule = container.resolve(Modules.INVENTORY) as InventoryModule;
    const productModule = container.resolve(Modules.PRODUCT) as ProductModule;
    const remoteLink = container.resolve("remoteLink") as RemoteLink;
    const logger = container.resolve("logger");

    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "variants.id",
        "variants.sku",
        "variants.title",
        "variants.inventory_items.inventory_item_id",
      ],
      filters: { id: input.product_id } as Record<string, unknown>,
    });

    const product = (products as ProductGraphRecord[])[0];
    if (!product) {
      throw new Error(
        `Cannot initialize Miami inventory levels: product ${input.product_id} not found`
      );
    }

    const invIds = new Set<string>();
    const createdInventoryItemIds: string[] = [];

    for (const variant of product.variants ?? []) {
      const variantInventoryIds = (variant.inventory_items ?? [])
        .map((link) => link.inventory_item_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      for (const id of variantInventoryIds) {
        invIds.add(id);
      }

      if (variantInventoryIds.length > 0) continue;

      if (!variant.id) {
        throw new Error(
          `Cannot auto-create inventory item: Inventory product ${input.product_id} has a variant without id`
        );
      }

      const sku = variant.sku?.trim() || variant.id;
      const title = variant.title?.trim() || sku;
      const inventoryItem = await inventoryModule.createInventoryItems({
        sku,
        title,
        requires_shipping: true,
      });

      await remoteLink.create({
        [Modules.PRODUCT]: { variant_id: variant.id },
        [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
      });

      await productModule.updateProductVariants(variant.id, {
        manage_inventory: true,
      });

      invIds.add(inventoryItem.id);
      createdInventoryItemIds.push(inventoryItem.id);
      logger.warn(
        `[ensure-miami-levels] auto-created inventory_item ${inventoryItem.id} for ${variantLabel(variant)}`
      );
    }

    if (invIds.size === 0) {
      throw new Error(
        `Cannot initialize Miami inventory levels: Inventory product ${input.product_id} has no variants or linked inventory items`
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

    if (toCreate.length > 0) {
      try {
        await inventoryModule.createInventoryLevels(
          toCreate.map((inventoryItemId) => ({
            inventory_item_id: inventoryItemId,
            location_id: USA_LOC,
            stocked_quantity: 0,
          }))
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        // Race-safe fallback: if another process created the levels between
        // listInventoryLevels and createInventoryLevels, accept the healed state.
        const afterCreateAttempt = await inventoryModule.listInventoryLevels(
          { inventory_item_id: toCreate, location_id: USA_LOC },
          { take: toCreate.length }
        );
        const recovered = new Set(
          afterCreateAttempt.map((l) => l.inventory_item_id)
        );
        const stillMissing = toCreate.filter((id) => !recovered.has(id));

        if (stillMissing.length > 0) {
          throw new Error(
            `Cannot initialize Miami inventory levels for product ${input.product_id}: ${message}`
          );
        }
      }
    }

    logger.info(
      `[ensure-miami-levels] product=${input.product_id} inventory_auto_created=${createdInventoryItemIds.length} levels_created=${toCreate.length} already=${haveLevel.size}`
    );

    return new StepResponse(
      {
        created_inventory_item_ids: toCreate,
        already_present: haveLevel.size,
      },
      null
    );
  }
);
