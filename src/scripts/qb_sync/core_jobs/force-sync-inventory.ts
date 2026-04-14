/**
 * Force sync inventory to MeiliSearch with correct prices
 */

import { syncInventoryWorkflow } from "../workflows/sync-inventory";

export default async function forceSyncInventory({ container }: any) {
  const logger = container.resolve("logger");

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔄 FORCING INVENTORY SYNC TO MEILISEARCH\n`);

  try {
    const { result } = await syncInventoryWorkflow(container).run({
      input: {},
    });

    log(`\n✅ SYNC COMPLETE`);
    log(`   Items synced: ${result.synced}`);
    log(`   Success: ${result.success}`);

    log(`\n📝 Now check MeiliSearch for EPS-MDA-60-24 price...`);

    return { success: true, result };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}
