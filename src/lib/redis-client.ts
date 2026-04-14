/**
 * lib/redis-client.ts
 * Singleton ioredis client for use in custom Medusa lock route handlers.
 *
 * Notes:
 * - Medusa v2 does NOT expose its internal Redis client via the DI container.
 * - We create our own connection using REDIS_URL from the environment.
 * - keepAlive: 10_000  → sends TCP keep-alive packets every 10s to prevent
 *   Railway / cloud Redis from closing idle connections with ETIMEDOUT.
 * - retryStrategy    → auto-reconnects up to 5 times with exponential backoff.
 */
import Redis from "ioredis";

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (!_client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "[Document Lock] REDIS_URL environment variable is not set"
      );
    }

    _client = new Redis(url, {
      // Keep TCP connection alive — prevents Railway from closing idle connections
      keepAlive: 10_000,
      // Reconnect with exponential backoff (100ms → 200ms → 400ms … max 2s)
      retryStrategy: (times) => {
        if (times > 5) return null; // Stop retrying after 5 attempts; let next request retry
        return Math.min(100 * 2 ** times, 2000);
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    _client.on("error", (err) => {
      // Log but don't crash — ioredis will auto-reconnect
      console.warn(
        "[Document Lock] Redis error (will auto-reconnect):",
        err.message
      );
    });

    _client.on("reconnecting", () => {
      console.info("[Document Lock] Redis reconnecting…");
    });

    _client.on("ready", () => {
      console.info("[Document Lock] Redis connection ready");
    });
  }
  return _client;
}
