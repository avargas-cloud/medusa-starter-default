/**
 * Force a FULL rebuild of the MeiliSearch `inventory` index (settings + all
 * docs), bypassing the drift-aware skip in POST /admin/search/inventory/sync.
 *
 * Needed after a schema change that adds a FIELD to the doc (e.g.
 * is_sourced_via_agent) without changing the doc COUNT — the drift detector
 * only samples count/timestamp/variantId, so the button reports "synced (0)"
 * and never backfills the new field or applies the new filterableAttributes.
 *
 * Run:
 *   env DATABASE_URL=... MEILISEARCH_HOST=... MEILISEARCH_API_KEY=... REDIS_URL=... \
 *     npx medusa exec ./src/scripts/fix/force-reindex-inventory.ts
 */
import { syncInventoryWorkflow } from "../../workflows/sync-inventory";

export default async function forceReindexInventory({ container }: any) {
  console.log("🔄 FORCE full inventory reindex (settings + all docs)...");
  const { result } = await syncInventoryWorkflow(container).run({ input: {} });
  console.log(`✅ done — synced ${result.synced} docs, success=${result.success}`);
  return result;
}
