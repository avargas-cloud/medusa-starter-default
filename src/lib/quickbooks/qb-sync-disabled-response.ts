import type { MedusaResponse } from "@medusajs/framework/http";

import { QbSyncDisabledError } from "./sync-enabled";

/**
 * Shared 409 shape for routes that call the QB bridge synchronously
 * (`bridgeFetch`/`client/core.ts`'s `bridgeFetch` — both throw
 * `QbSyncDisabledError` instead of reaching the network when
 * `QB_SYNC_ENABLED=false`). A route's generic catch block calls this first;
 * if it returns `true` the response is already sent and the route returns.
 */
export function respondQbSyncDisabled(
  error: unknown,
  res: MedusaResponse
): boolean {
  if (!(error instanceof QbSyncDisabledError)) return false;
  res.status(409).json({
    error: error.message,
    code: "QB_SYNC_DISABLED",
  });
  return true;
}
