/**
 * Force-resync specific customers to MeiliSearch. Use when an update missed
 * the auto-sync (e.g., subscriber didn't run because the parent script exited
 * before the async handler did).
 *
 * Run:
 *   CUSTOMER_IDS=cus_01ABC,cus_01DEF yarn medusa exec ./src/scripts/fix/resync-customers-to-meili.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { syncCustomerToMeili } from "../../lib/meilisearch/sync-customer";

export default async function resyncCustomersToMeili({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const ids = (process.env.CUSTOMER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error("CUSTOMER_IDS env var required (comma-separated)");
  }

  console.log(`[resync-meili] resyncing ${ids.length} customers to MeiliSearch`);
  for (const id of ids) {
    try {
      await syncCustomerToMeili(id, container, logger);
      console.log(`[resync-meili] ✅ ${id}`);
    } catch (err: unknown) {
      console.log(`[resync-meili] ❌ ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`[resync-meili] Done.`);
}
