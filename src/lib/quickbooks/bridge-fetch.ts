/**
 * Centralized HTTP client for the QuickBooks Bridge service.
 *
 * Why this exists:
 * - Each poller used to have its own fetch wrapper with inconsistent error handling.
 * - HTTP 404 from the bridge means "operation expired / no longer in queue", not a fatal error.
 *   Treating it as fatal caused rows to remain stuck in `submitted` indefinitely
 *   (incident PO-1015/PO-1016, 2026-04-29).
 *
 * This module standardizes: 404 → expired sentinel, other non-2xx → BridgeFetchError.
 */

export class BridgeFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly isExpired: boolean = false,
    public readonly body?: string
  ) {
    super(`Bridge HTTP ${status}${isExpired ? " (operation expired)" : ""}`);
    this.name = "BridgeFetchError";
  }
}

export interface BridgeFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function bridgeUrl(): string {
  const url = process.env.QB_BRIDGE_URL;
  if (!url) {
    throw new Error("QB_BRIDGE_URL environment variable is not set");
  }
  return url.replace(/\/+$/, "");
}

function bridgeApiKey(): string {
  // Accept both env var names: QB_BRIDGE_API_KEY (new convention) and QB_API_KEY
  // (existing in deployed .env). Without this fallback, polls return 401 and the
  // 404→expired translation never fires (incident PO-1015/PO-1016, 2026-04-29).
  return process.env.QB_BRIDGE_API_KEY ?? process.env.QB_API_KEY ?? "";
}

/**
 * Low-level fetch wrapper. Throws BridgeFetchError on non-2xx.
 * 404 is marked with isExpired=true so callers can branch.
 */
export async function bridgeFetch<T = unknown>(
  path: string,
  opts: BridgeFetchOptions = {}
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = `${bridgeUrl()}${path.startsWith("/") ? path : "/" + path}`;

  const controller = opts.signal ? undefined : new AbortController();
  const timeoutId =
    !opts.signal && opts.timeoutMs
      ? setTimeout(() => controller!.abort(), opts.timeoutMs)
      : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": bridgeApiKey(),
        "bypass-tunnel-reminder": "true",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? controller?.signal,
    });

    if (res.status === 404) {
      throw new BridgeFetchError(404, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BridgeFetchError(res.status, false, body);
    }

    return (await res.json()) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type BridgeStatusResult =
  | { status: "expired" }
  | {
      status: "queued" | "processing" | "completed" | "failed";
      data: Record<string, unknown>;
    };

/**
 * Polls bridge for an operation's status.
 *
 * Returns `{ status: "expired" }` if the bridge returns 404 (operation no longer
 * known to bridge — typically because the queue was cleaned, bridge restarted with
 * stripped state, or the operation completed and was purged past retention window).
 *
 * Callers should treat "expired" as: clear `qb_operation_id`, mark row as `error`
 * with descriptive `last_error`, and let the normal retry cycle re-submit.
 */
export async function pollBridgeStatus(
  operationId: string
): Promise<BridgeStatusResult> {
  try {
    const data = await bridgeFetch<{
      operation?: { status?: string };
    } & Record<string, unknown>>(`/api/sync/status/${operationId}`);

    const status = (data?.operation?.status ?? "queued") as
      | "queued"
      | "processing"
      | "completed"
      | "failed";
    return { status, data };
  } catch (err) {
    if (err instanceof BridgeFetchError && err.isExpired) {
      return { status: "expired" };
    }
    throw err;
  }
}
