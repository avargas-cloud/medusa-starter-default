import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { createHash } from "crypto";

/**
 * Generic request-level idempotency middleware (Phase 3 — see
 * docs/IDEMPOTENCY_PLAN.md). Backed by the `idempotency_key` table
 * (migration 1779600000000). Reviewed/hardened with Codex.
 *
 * Active only when the client sends an `Idempotency-Key` header:
 *  - First request claims the key (`in_flight`), runs the handler, and records
 *    the response. The real `res.json` is deferred (bounded by a 1s timeout)
 *    until the row is marked `completed`, so a fast retry sees the cached body.
 *  - Replay (same key) after a 2xx: replays the cached status + body.
 *  - A non-2xx response DELETES the claim, so a corrected/retried submission
 *    with the same key is allowed (a 400 validation error must not lock the key).
 *  - Concurrent duplicate while the first is `in_flight`: 409 IN_PROGRESS — the
 *    handler does NOT run, which is what prevents the duplicate create even for
 *    non-idempotent side effects (e.g. a QB bridge call).
 *  - `in_flight` older than the stale window: 409 STATE_UNKNOWN (we never blindly
 *    re-run a generic create — a crash mid-flight may have left side effects).
 *  - Same key, different route/payload: 409 CONFLICT.
 *
 * Fails CLOSED (503) when the header is present but the idempotency store can't
 * be reached — once the client asks for the guarantee we must not silently run
 * the create twice.
 *
 * Scope: only register on JSON API routes (the response capture patches
 * `res.json`). It dedups SAME-key double-submit/retry; it does NOT dedup two
 * different intents that happen to be identical (use a domain unique index).
 */
type Pg = { raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const STALE_MS = 60_000;
const FINALIZE_TIMEOUT_MS = 1_000;

/** Stable JSON with recursively sorted object keys (canonical request hash). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(src[k]);
        return acc;
      }, {});
  }
  return value;
}

export function idempotency(routeLabel: string) {
  return async function idempotencyMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) {
    const raw = req.headers["idempotency-key"];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) return next();

    const pg = req.scope.resolve<Pg>("__pg_connection__");
    const requestHash = createHash("sha256")
      .update(JSON.stringify(canonicalize(req.body ?? {})))
      .digest("hex");

    const failClosed = () =>
      res.status(503).json({
        code: "IDEMPOTENCY_UNAVAILABLE",
        error: "Could not verify idempotency state. Retry shortly.",
      });

    // ── Claim ────────────────────────────────────────────────────────────
    let claimed = false;
    try {
      const ins = await pg.raw(
        `INSERT INTO idempotency_key (key, route, request_hash)
         VALUES (?, ?, ?)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, routeLabel, requestHash]
      );
      claimed = (ins.rows?.length ?? 0) > 0;
    } catch {
      return failClosed();
    }

    if (!claimed) {
      let row: any;
      try {
        const existing = await pg.raw(
          `SELECT route, request_hash, status, response_status, response_body,
                  (locked_at < now() - interval '${STALE_MS} milliseconds') AS stale
             FROM idempotency_key WHERE key = ?`,
          [key]
        );
        row = existing.rows?.[0];
      } catch {
        return failClosed();
      }
      if (!row) return next(); // claim vanished (rolled back) — proceed fresh

      if (row.route !== routeLabel || row.request_hash !== requestHash) {
        return res.status(409).json({
          code: "IDEMPOTENCY_CONFLICT",
          error: "This Idempotency-Key was already used for a different request.",
        });
      }
      if (row.status === "completed") {
        return res
          .status(row.response_status ?? 200)
          .json(row.response_body ?? {});
      }
      // in_flight
      if (row.stale) {
        return res.status(409).json({
          code: "IDEMPOTENCY_STATE_UNKNOWN",
          error:
            "The original request may have completed. Refresh and verify before retrying.",
        });
      }
      res.setHeader("Retry-After", "2");
      return res.status(409).json({
        code: "IDEMPOTENCY_IN_PROGRESS",
        error: "A request with this Idempotency-Key is still processing. Retry shortly.",
      });
    }

    // ── Claimed → run handler, capture the response ──────────────────────
    // 2xx → cache & replay. Non-2xx → DELETE the claim so a corrected retry with
    // the same key is allowed (validation 400 must not lock the key forever).
    const finalize = async (status: number, body: unknown): Promise<void> => {
      try {
        if (status >= 200 && status < 300) {
          await pg.raw(
            `UPDATE idempotency_key
                SET status = 'completed', response_status = ?, response_body = ?::jsonb,
                    completed_at = now()
              WHERE key = ?`,
            [status, JSON.stringify(body ?? null), key]
          );
        } else {
          await pg.raw(`DELETE FROM idempotency_key WHERE key = ?`, [key]);
        }
      } catch {
        /* best-effort — a lingering in_flight row is gated by the stale window */
      }
    };

    const originalJson = res.json.bind(res);
    let captured = false;
    res.json = (body: unknown) => {
      if (captured) return res;
      captured = true;
      const status = res.statusCode || 200;
      // Bound the wait so a slow/stuck DB never hangs the user's response.
      void Promise.race([
        finalize(status, body),
        new Promise<void>((resolve) => setTimeout(resolve, FINALIZE_TIMEOUT_MS)),
      ]).finally(() => {
        if (!res.headersSent && !res.writableEnded) originalJson(body);
      });
      return res;
    };

    // Handler ended without res.json (res.send/end) or threw before responding:
    // drop the claim so it doesn't linger as in_flight and a retry can proceed.
    res.on("finish", () => {
      if (captured) return;
      void pg.raw(`DELETE FROM idempotency_key WHERE key = ?`, [key]).catch(() => {});
    });

    return next();
  };
}
