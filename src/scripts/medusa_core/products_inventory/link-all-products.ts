#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import {
  ISalesChannelModuleService,
  IProductModuleService,
} from "@medusajs/types";

/**
 * link-all-products-to-channels.ts
 *
 * This script finds ALL products in the database
 * and links them to ALL available sales channels (Default and POS).
 * This fixes the issue of pre-existing products not showing up in POS.
 */

export default async function linkAllProductsToChannels({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );
  const scModule: ISalesChannelModuleService = container.resolve(
    Modules.SALES_CHANNEL
  );
  const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK);

  logger.info("=".repeat(65));
  logger.info("🔗 LINKING **ALL** PRODUCTS TO ALL SALES CHANNELS");
  logger.info("=".repeat(65));

  // 1. Get all Sales Channels
  const channels = await scModule.listSalesChannels({});
  const channelIds = channels.map((c) => c.id);
  logger.info(`📋 Found ${channelIds.length} Sales Channels:`);
  channels.forEach((c) => logger.info(`   - ${c.name} (${c.id})`));

  if (channelIds.length === 0) {
    logger.error("❌ No sales channels found. Aborting.");
    return;
  }

  // 2. Fetch all products in pagination until exhausted
  logger.info("\n🔍 Fetching all products from database...");

  const BATCH_SIZE = 500;
  let skip = 0;
  let allProductIds: string[] = [];

  while (true) {
    const products = await productModule.listProducts(
      {},
      { select: ["id"], skip, take: BATCH_SIZE }
    );
    if (products.length === 0) break;

    products.forEach((p) => allProductIds.push(p.id));
    skip += BATCH_SIZE;
    logger.info(`   Fetched ${allProductIds.length} products total so far...`);
  }

  logger.info(`\n📦 Found ${allProductIds.length} Total products to link...`);

  if (allProductIds.length === 0) {
    logger.info("✅ No products found.");
    return;
  }

  // 3. Link them in chunks
  logger.info("\n⚙️  Linking products to channels...");
  const chunkSize = 100;
  let linked = 0;

  for (let i = 0; i < allProductIds.length; i += chunkSize) {
    const chunkIds = allProductIds.slice(i, i + chunkSize);

    // Create link definitions for all channels and all products in chunk
    const links: any[] = [];
    for (const pid of chunkIds) {
      for (const scid of channelIds) {
        links.push({
          [Modules.PRODUCT]: { product_id: pid },
          [Modules.SALES_CHANNEL]: { sales_channel_id: scid },
        });
      }
    }

    try {
      await remoteLink.create(links);
      linked += chunkIds.length;
      logger.info(
        `   ✅ Linked ${linked} / ${allProductIds.length} products...`
      );
    } catch (err: any) {
      // remoteLink.create throws if a link already exists. We catch it and fallback to 1-by-1
      logger.info(
        `   ⚠️  Chunk ${i} had some already linked items, doing 1-by-1...`
      );

      for (const pid of chunkIds) {
        for (const scid of channelIds) {
          try {
            await remoteLink.create([
              {
                [Modules.PRODUCT]: { product_id: pid },
                [Modules.SALES_CHANNEL]: { sales_channel_id: scid },
              },
            ]);
          } catch (e: any) {
            // Ignore if it's just 'already exists', otherwise log
            if (!e.message.includes("already exists")) {
              logger.error(`      Failed for product ${pid}: ${e.message}`);
            }
          }
        }
        linked++;
      }
      logger.info(
        `   ✅ Recovered chunk ${i}, linked ${linked} / ${allProductIds.length} products...`
      );
    }
  }

  logger.info("\n" + "=".repeat(65));
  logger.info(
    `✅ SUCCESS: Ensured ${allProductIds.length} products are linked to ${channelIds.length} channels.`
  );
  logger.info("=".repeat(65));
}
