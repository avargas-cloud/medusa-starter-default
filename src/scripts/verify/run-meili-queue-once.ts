/**
 * Run the MeiliSearch sync queue processor once, ad-hoc, for verification.
 *
 *   yarn medusa exec ./src/scripts/verify/run-meili-queue-once.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import meiliSyncQueueProcessor from "../../jobs/meili-sync-queue-processor";

export default async function runMeiliQueueOnce({ container }: ExecArgs): Promise<void> {
  console.log("[queue-once] starting worker pass...");
  await meiliSyncQueueProcessor(container);
  console.log("[queue-once] done");
}
