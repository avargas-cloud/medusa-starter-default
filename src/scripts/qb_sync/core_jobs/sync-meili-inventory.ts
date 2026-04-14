/**
 * Force re-index Meilisearch Inventory Index
 *
 * Use after price syncs or any Medusa DB change that doesn't
 * touch inventory_items.updated_at (which would bypass the
 * "already synced" timestamp check in /admin/search/inventory/sync).
 *
 * Run: yarn medusa exec ./src/scripts/sync/sync-meili-inventory.ts
 */

import { ExecArgs } from "@medusajs/framework/types";
import { syncInventoryWorkflow } from "../../workflows/sync-inventory";

export default async function syncMeiliInventory({ container }: ExecArgs) {
  const logger = (container as any).resolve("logger");

  logger.info(
    "🔄 Force re-indexing Meilisearch Inventory (with fresh prices from DB)..."
  );

  const { result } = await syncInventoryWorkflow(container).run({ input: {} });

  logger.info(
    `✅ Done! Re-indexed ${result.synced} items (${result.itemsWithCategory} with category)`
  );
}
