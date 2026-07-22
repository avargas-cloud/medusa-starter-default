/**
 * POST /pub/webhooks/uber — Uber Direct status webhook (plan §Fase 8).
 *
 * The 6h poll cron is too stale for a same-day courier; Uber pushes
 * `event.delivery_status` / `event.courier_update` here the moment anything
 * changes. REQUIRED before UBER_DIRECT_MODE=live in prod.
 *
 * Security:
 *  - `X-Uber-Signature` = HMAC-SHA256 hex of the RAW request body, keyed with
 *    the webhook signing key (dashboard → Developer → Webhooks). Verification
 *    MUST use the raw bytes (`preserveRawBody` in middlewares.ts) — Node's
 *    re-stringified JSON does not round-trip byte-identically.
 *  - Both live and test signing keys are accepted (UBER_DIRECT_WEBHOOK_SECRET /
 *    UBER_DIRECT_TEST_WEBHOOK_SECRET) — test dispatches from sandbox and live
 *    dispatches from prod hit the same public URL.
 *  - No key configured → 503 fail-closed (never process unsigned events).
 *
 * Idempotent/replay-safe by construction: transitions run through
 * applyStatusUpdate (forward-only), so replays and out-of-order events no-op.
 * Unknown delivery ids ACK 200 (deliveries created outside the POS — never
 * make Uber retry-loop on them).
 */

import { createHmac, timingSafeEqual } from "crypto";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { mapUberDeliveryStatus } from "../../../../lib/shipping-dispatch/uber-adapter";
import { applyStatusUpdate } from "../../../../lib/shipping-dispatch/status";
import type { DeliveryStatus } from "../../../../lib/shipping-dispatch/types";
import { getDbPool } from "../../../utils/db-pool";

export const AUTHENTICATE = false;

function signingKeys(): string[] {
  return [
    process.env.UBER_DIRECT_WEBHOOK_SECRET,
    process.env.UBER_DIRECT_TEST_WEBHOOK_SECRET,
  ].filter((k): k is string => Boolean(k?.trim()));
}

function signatureValid(rawBody: Buffer, signature: string): boolean {
  const provided = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return signingKeys().some((key) => {
    const expected = Buffer.from(
      createHmac("sha256", key).update(rawBody).digest("hex"),
      "utf8"
    );
    return (
      expected.length === provided.length && timingSafeEqual(expected, provided)
    );
  });
}

interface UberWebhookBody {
  id?: string;
  kind?: string;
  status?: string;
  delivery_id?: string;
  data?: {
    id?: string;
    status?: string;
    undeliverable_reason?: string;
    updated?: string;
    courier?: { name?: string };
    dropoff?: { status_timestamp?: string };
  };
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (signingKeys().length === 0) {
    return res
      .status(503)
      .json({ code: "not_configured", message: "no webhook signing key configured" });
  }

  const signature = req.headers["x-uber-signature"];
  const raw = (req as MedusaRequest & { rawBody?: Buffer }).rawBody;
  if (typeof signature !== "string" || !raw || raw.length === 0) {
    return res.status(401).json({ code: "unauthorized", message: "missing signature/body" });
  }
  if (!signatureValid(raw, signature)) {
    return res.status(401).json({ code: "unauthorized", message: "bad signature" });
  }

  const body = (req.body ?? {}) as UberWebhookBody;
  const deliveryId = body.delivery_id ?? body.data?.id;
  const uberStatus = body.status ?? body.data?.status;
  if (!deliveryId || !uberStatus) {
    // Signed but not a status event we act on (e.g. refund notices) — ACK.
    return res.status(200).json({ ok: true, ignored: body.kind ?? "no_status" });
  }

  const pool = getDbPool();
  const { rows } = await pool.query<{ id: string; status: DeliveryStatus }>(
    `SELECT id, status FROM order_delivery
      WHERE provider = 'uber' AND provider_object_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [deliveryId]
  );
  const row = rows[0];
  if (!row) {
    return res.status(200).json({ ok: true, ignored: "unknown_delivery" });
  }

  const next = applyStatusUpdate(row.status, mapUberDeliveryStatus(uberStatus));
  if (!next || next === row.status) {
    return res.status(200).json({ ok: true, unchanged: row.status });
  }

  const detail = [
    `uber:${uberStatus} (webhook)`,
    body.data?.undeliverable_reason || null,
    body.data?.courier?.name ? `courier ${body.data.courier.name}` : null,
  ]
    .filter(Boolean)
    .join(" — ");
  const deliveredAt =
    next === "delivered"
      ? (body.data?.dropoff?.status_timestamp ?? body.data?.updated ?? null)
      : null;

  await pool.query(
    `UPDATE order_delivery
        SET status = $2,
            status_detail = $3,
            delivered_at = CASE WHEN $2 = 'delivered'
                                THEN COALESCE(delivered_at, $4::timestamptz, now())
                                ELSE delivered_at END,
            status_checked_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [row.id, next, detail, deliveredAt]
  );

  return res.status(200).json({ ok: true, status: next });
}
