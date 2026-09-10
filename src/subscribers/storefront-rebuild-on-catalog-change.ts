/**
 * STOREFRONT REBUILD ON CATALOG CHANGE
 *
 * The Astro storefront (`web/`) pre-renders the whole published catalog at
 * build time — there is no ISR/on-demand revalidation. Any product,
 * variant, or category mutation must trigger a Vercel rebuild via its
 * Deploy Hook, or the storefront silently drifts from Medusa.
 *
 * Debounce: catalog writes come in bursts (a CSV import, a bulk price
 * update). Firing one Deploy Hook POST per event would queue dozens of
 * redundant Vercel builds. A Redis key with a 120s TTL coalesces a burst
 * into a single POST — the first event in the window fires the hook and
 * plants the key; every other event inside the window just returns.
 *
 * Fail-open on cache errors: if Redis is unreachable we can't debounce, but
 * we still must not drop the rebuild — POST once anyway. The failure mode
 * of "no rebuild fired" (stale storefront) is worse than the failure mode
 * of "an extra build fired" (a few wasted Vercel minutes).
 *
 * Never log the hook URL — it lets anyone trigger a Vercel deploy for this
 * project (see `.claude/rules/secrets.md`).
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

const LOG_PREFIX = "[storefront-rebuild]";

const DEBOUNCE_KEY = "storefront:rebuild:pending";
const DEBOUNCE_TTL_SECONDS = 120;
const HOOK_TIMEOUT_MS = 10_000;

interface CacheLike {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, data: unknown, ttl?: number) => Promise<void>;
  invalidate: (key: string) => Promise<void>;
}

interface ScopeLike {
  resolve: (key: string) => unknown;
}

function getCache(scope: ScopeLike): CacheLike | null {
  try {
    return scope.resolve(Modules.CACHE) as CacheLike;
  } catch {
    return null;
  }
}

// Logged once per process so a burst of events (or a permanently-unconfigured
// preview env) doesn't spam the log with the same line forever.
let warnedNotConfigured = false;

async function postDeployHook(hookUrl: string): Promise<{ ok: boolean; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
  try {
    const res = await fetch(hookUrl, { method: "POST", signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export default async function storefrontRebuildOnCatalogChange({
  event,
  container,
}: SubscriberArgs<unknown>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  const hookUrl = process.env.VERCEL_WEB_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    if (!warnedNotConfigured) {
      logger.info(
        `${LOG_PREFIX} storefront rebuild hook not configured; skipping`
      );
      warnedNotConfigured = true;
    }
    return;
  }

  const cache = getCache(container as ScopeLike);

  // Coalesce: if a rebuild is already pending within the debounce window,
  // this event rides along with it — nothing more to do.
  if (cache) {
    try {
      const pending = await cache.get<boolean>(DEBOUNCE_KEY);
      if (pending) return;
    } catch {
      // Fail-open: can't tell if a rebuild is pending — POST anyway below.
    }
  }

  // Plant the key BEFORE the POST so a slow/hanging hook call doesn't let a
  // second event through in the meantime. If planting fails, we still POST
  // (fail-open) — the next event just won't be able to coalesce against us.
  if (cache) {
    try {
      await cache.set(DEBOUNCE_KEY, true, DEBOUNCE_TTL_SECONDS);
    } catch {
      // Cache unreachable — proceed without debounce, per fail-open policy.
    }
  }

  try {
    const { ok, status } = await postDeployHook(hookUrl);
    if (ok) {
      logger.info(`${LOG_PREFIX} storefront rebuild triggered by ${event.name}`);
    } else {
      logger.warn(
        `${LOG_PREFIX} deploy hook responded with non-2xx status ${status} for ${event.name} — retrying on next event`
      );
      if (cache) await cache.invalidate(DEBOUNCE_KEY).catch(() => {});
    }
  } catch (err: unknown) {
    logger.warn(
      `${LOG_PREFIX} deploy hook request failed for ${event.name}: ${
        (err as Error).message
      } — retrying on next event`
    );
    if (cache) await cache.invalidate(DEBOUNCE_KEY).catch(() => {});
  }
}

export const config: SubscriberConfig = {
  event: [
    "product.created",
    "product.updated",
    "product.deleted",
    "product-variant.created",
    "product-variant.updated",
    "product-variant.deleted",
    "product-category.created",
    "product-category.updated",
    "product-category.deleted",
  ],
};
