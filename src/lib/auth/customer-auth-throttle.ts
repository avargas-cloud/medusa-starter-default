/**
 * Redis-backed throttle for customer-facing auth endpoints (login, register,
 * password reset) — same house pattern as `src/lib/pos/supervisor-pin-guard.ts`:
 * a sliding-window counter in the cache module, fail-OPEN only when the CACHE
 * itself is unreachable, never on a wrong credential (a down Redis must not
 * lock every customer out of login).
 *
 * Two independent counters, because they defend against two different
 * shapes of abuse:
 *   - per IP:    a script hammering the endpoint from one source.
 *   - per email: credential-stuffing/enumeration against ONE account from
 *     many IPs (a botnet). Only counted when the body carries a string
 *     `email` — some of these routes may be hit without one.
 */
import { Modules } from "@medusajs/utils";
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

interface CacheLike {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, data: unknown, ttl?: number) => Promise<void>;
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

function clientIp(req: MedusaRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedFirst = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    req.ip ||
    forwardedFirst?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Increments the counter at `key`; reports whether `max` was already reached. */
async function checkAndBump(
  cache: CacheLike,
  key: string,
  max: number,
  windowSec: number
): Promise<{ limited: boolean }> {
  let count = 0;
  try {
    count = Number((await cache.get<number>(key)) ?? 0);
  } catch {
    // Cache unreadable: same fail-open as the PIN guard — don't block.
    return { limited: false };
  }
  if (count >= max) {
    return { limited: true };
  }
  try {
    await cache.set(key, count + 1, windowSec);
  } catch {
    /* best-effort — a lost increment only weakens the count, never blocks */
  }
  return { limited: false };
}

export function customerAuthThrottle(options: {
  bucket: string;
  maxPerIp?: number;
  windowSec?: number;
  maxPerEmail?: number;
  emailWindowSec?: number;
}) {
  const {
    bucket,
    maxPerIp = 10,
    windowSec = 60,
    maxPerEmail = 5,
    emailWindowSec = 900,
  } = options;

  return async function customerAuthThrottleMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const cache = getCache(req.scope as unknown as ScopeLike);
    if (!cache) return next(); // fail-open: cache down, never the credential's fault

    const ipKey = `auth_throttle:${bucket}:ip:${clientIp(req)}`;
    const ipResult = await checkAndBump(cache, ipKey, maxPerIp, windowSec);
    if (ipResult.limited) {
      res.setHeader("Retry-After", String(windowSec));
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again later." });
    }

    const email =
      typeof (req.body as { email?: unknown })?.email === "string"
        ? ((req.body as { email: string }).email.toLowerCase())
        : null;
    if (email) {
      const emailKey = `auth_throttle:${bucket}:email:${email}`;
      const emailResult = await checkAndBump(
        cache,
        emailKey,
        maxPerEmail,
        emailWindowSec
      );
      if (emailResult.limited) {
        res.setHeader("Retry-After", String(emailWindowSec));
        return res
          .status(429)
          .json({ error: "Too many attempts. Try again later." });
      }
    }

    return next();
  };
}
