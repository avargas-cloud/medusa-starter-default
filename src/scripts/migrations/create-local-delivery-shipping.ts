#!/usr/bin/env tsx
/**
 * create-local-delivery-shipping.ts
 *
 * Creates the "Local Delivery" shipping option — the store's own hired driver.
 * Mirror of create-uber-shipping.ts (same zone/profile, flat $0, POS-only).
 *
 * The POS DispatchModal recognizes this method by name and shows a simple
 * "confirm handoff" action instead of the label/rates flow — the order is
 * marked delivered the moment the goods are handed to the driver.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/migrations/create-local-delivery-shipping.ts
 *
 * Railway only runs DB migrations on deploy — run this manually against prod
 * (and once against the sandbox) after the deploy is ACTIVE.
 */

import { Client } from "pg";
import { ExecArgs } from "@medusajs/framework/types";
import { createShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";
import { Modules, generateEntityId } from "@medusajs/utils";

// IDs confirmed from production DB (2026-04-08, same as create-uber-shipping)
const STOCK_LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR"; // Ecopowertech Miami
const SERVICE_ZONE_ID = "serzo_01KH9VSRWMMTXAY1BXASMM0G0F"; // United States
const SHIPPING_PROFILE_ID = "sp_01KFH54TAP34J6ZYRE1NZWGSG2"; // Default Shipping Profile
const PROVIDER_ID = "local-delivery_local-delivery";

export default async function createLocalDeliveryShipping({ container }: ExecArgs) {
  const logger = container.resolve("logger") as {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };

  logger.info("Creating Local Delivery shipping option...");

  // Step 1: Guard — skip if shipping option already exists
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT) as {
    listShippingOptions: (
      filters: Record<string, unknown>
    ) => Promise<{ id: string; name: string }[]>;
  };
  const existing = await fulfillmentModule.listShippingOptions({
    name: "Local Delivery",
  });
  if (existing.length > 0) {
    logger.info(
      `Local Delivery shipping option already exists (id: ${existing[0].id}) — skipping.`
    );
    return;
  }

  // Step 2: Link provider to stock location if not already linked
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM location_fulfillment_provider
             WHERE stock_location_id = $1 AND fulfillment_provider_id = $2`,
      [STOCK_LOCATION_ID, PROVIDER_ID]
    );
    if (rows.length === 0) {
      const linkId = generateEntityId("locfp", "");
      await pg.query(
        `INSERT INTO location_fulfillment_provider
                    (stock_location_id, fulfillment_provider_id, id, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW())`,
        [STOCK_LOCATION_ID, PROVIDER_ID, linkId]
      );
      logger.info(
        `Linked ${PROVIDER_ID} to stock location ${STOCK_LOCATION_ID}`
      );
    } else {
      logger.info("Provider already linked to location — skipping link step.");
    }
  } finally {
    await pg.end();
  }

  // Step 3: Create the Local Delivery shipping option
  // metadata is accepted at runtime but missing from the TS type — cast input to bypass
  const input = [
    {
      name: "Local Delivery",
      price_type: "flat" as const,
      provider_id: PROVIDER_ID,
      service_zone_id: SERVICE_ZONE_ID,
      shipping_profile_id: SHIPPING_PROFILE_ID,
      type: {
        label: "Local Delivery",
        description:
          "Delivered by our own hired driver — price set manually per order",
        code: "local-delivery",
      },
      prices: [
        {
          currency_code: "usd",
          amount: 0,
        },
      ],
      // No `enabled_in_store` rule → invisible to web storefront checkout
      rules: [
        {
          attribute: "is_return",
          value: "false",
          operator: "eq",
        },
      ],
      metadata: { pos_only: true },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;

  await createShippingOptionsWorkflow(container).run({ input });

  logger.info(
    "✅ Local Delivery shipping option created. Update the price from Medusa Admin or via POS inline editor."
  );
}
