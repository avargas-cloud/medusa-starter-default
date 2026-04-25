/**
 * Run purchasing snapshot recalculation directly (no HTTP auth needed).
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/sync/run-purchasing-snapshot.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

import { runPurchasingSnapshot } from "../../services/purchasing/snapshot.service";

async function main() {
  console.log("[snapshot] Starting full recalculation…");
  const result = await runPurchasingSnapshot();
  console.log(`[snapshot] Done — processed: ${result.processed}, errors: ${result.errors}, duration: ${result.durationMs}ms`);
  process.exit(result.errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[snapshot] Fatal:", e);
  process.exit(1);
});
