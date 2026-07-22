/**
 * src/lib/shipping-dispatch/uber-adapter.ts
 *
 * Uber Direct dispatch adapter (plan §Fase 3). Not a parcel carrier: a
 * same-day LOCAL courier. There is no label — createLabel() returns the
 * courier dispatch with a live tracking_url and the delivery id standing in
 * for the tracking number (label_url stays null everywhere).
 *
 * API (verified live 2026-07-22 + uber/uber-direct-sdk openapi):
 *  - OAuth2 client_credentials, scope `eats.deliveries` (NOT the
 *    `direct.organizations` scope — that one issues tokens but 401s on the
 *    deliveries endpoints). Token lasts 30d; cached per credential set.
 *  - Quote:  POST /v1/customers/{cid}/delivery_quotes — expires in ~15min,
 *    so quote→create are COUPLED inside createLabel (never a stored quote).
 *  - Create: POST /v1/customers/{cid}/deliveries (quote_id + manifest).
 *  - Status: GET  /v1/customers/{cid}/deliveries/{id} (webhook = Fase 8).
 *  - Cancel: POST /v1/customers/{cid}/deliveries/{id}/cancel.
 *
 * SAFE-BY-DEFAULT like UPS/Shippo: Uber separates test/live by CREDENTIALS
 * (same host), so money-moving ops (create/cancel) and status reads use the
 * UBER_DIRECT_TEST_* credential set unless UBER_DIRECT_MODE=live (Railway
 * only). A bug in dev can never dispatch a real courier. In test mode every
 * delivery is created with a robo-courier that auto-advances statuses.
 */

import axios from "axios";

import type {
  CreateLabelContext,
  CreateLabelResult,
  DeliveryStatusUpdate,
  DispatchAdapter,
  DispatchAddress,
  DispatchParcel,
  RateOption,
} from "./types";
import { DispatchError } from "./types";
import { sanitizePhone } from "./phone";

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const API_BASE = "https://api.uber.com/v1/customers";
const SCOPE = "eats.deliveries";

interface UberCreds {
  clientId: string;
  clientSecret: string;
  customerId: string;
  mode: "live" | "test";
}

function liveCreds(): UberCreds | null {
  const { UBER_DIRECT_CLIENT_ID, UBER_DIRECT_CLIENT_SECRET, UBER_DIRECT_CUSTOMER_ID } =
    process.env;
  if (!UBER_DIRECT_CLIENT_ID || !UBER_DIRECT_CLIENT_SECRET || !UBER_DIRECT_CUSTOMER_ID) {
    return null;
  }
  return {
    clientId: UBER_DIRECT_CLIENT_ID,
    clientSecret: UBER_DIRECT_CLIENT_SECRET,
    customerId: UBER_DIRECT_CUSTOMER_ID,
    mode: "live",
  };
}

function testCreds(): UberCreds | null {
  const {
    UBER_DIRECT_TEST_CLIENT_ID,
    UBER_DIRECT_TEST_CLIENT_SECRET,
    UBER_DIRECT_TEST_CUSTOMER_ID,
  } = process.env;
  if (
    !UBER_DIRECT_TEST_CLIENT_ID ||
    !UBER_DIRECT_TEST_CLIENT_SECRET ||
    !UBER_DIRECT_TEST_CUSTOMER_ID
  ) {
    return null;
  }
  return {
    clientId: UBER_DIRECT_TEST_CLIENT_ID,
    clientSecret: UBER_DIRECT_TEST_CLIENT_SECRET,
    customerId: UBER_DIRECT_TEST_CUSTOMER_ID,
    mode: "test",
  };
}

function isLiveMode(): boolean {
  return process.env.UBER_DIRECT_MODE === "live";
}

/** Credentials for money-moving ops + status. Strict: live mode needs live
 * creds; otherwise TEST creds are REQUIRED (never silently fall back to live). */
function dispatchCreds(): UberCreds {
  if (isLiveMode()) {
    const c = liveCreds();
    if (!c) {
      throw new DispatchError(
        "not_configured",
        "UBER_DIRECT_MODE=live but UBER_DIRECT_CLIENT_ID/SECRET/CUSTOMER_ID are missing"
      );
    }
    return c;
  }
  const c = testCreds();
  if (!c) {
    throw new DispatchError(
      "not_configured",
      "Uber Direct test credentials missing — set UBER_DIRECT_TEST_CLIENT_ID/SECRET/CUSTOMER_ID (Developer tab → Switch to testing), or UBER_DIRECT_MODE=live to use production credentials"
    );
  }
  return c;
}

/** Quotes are free/read-only: prefer the current mode's creds, fall back to
 * whichever set exists so rating works before test creds are captured. */
function quoteCreds(): UberCreds {
  const preferred = isLiveMode() ? liveCreds() : testCreds();
  const c = preferred ?? liveCreds() ?? testCreds();
  if (!c) {
    throw new DispatchError("not_configured", "Uber Direct credentials are not configured");
  }
  return c;
}

/** OAuth token cache per credential set (tokens last 30 days). */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: UberCreds): Promise<string> {
  const key = `${creds.mode}:${creds.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
  try {
    const res = await axios.post(
      AUTH_URL,
      new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: "client_credentials",
        scope: SCOPE,
      }),
      { timeout: 15000 }
    );
    const token = res.data?.access_token as string | undefined;
    const expiresIn = Number(res.data?.expires_in ?? 0);
    if (!token) throw new Error("no access_token in response");
    tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  } catch (e) {
    throw toDispatchError(e, "oauth");
  }
}

function toDispatchError(e: unknown, op: string): DispatchError {
  if (e instanceof DispatchError) return e;
  const ax = e as {
    response?: { status?: number; data?: { code?: string; message?: string } };
    message?: string;
  };
  const code = ax.response?.data?.code;
  const msg = [code, ax.response?.data?.message ?? ax.message ?? "unknown"]
    .filter(Boolean)
    .join(" ");
  if (code === "address_undeliverable" || code === "invalid_params") {
    return new DispatchError("invalid_address", `Uber ${op}: ${msg}`);
  }
  return new DispatchError("provider_error", `Uber ${op} failed: ${msg}`);
}

/** Uber requires E.164 (`^\+[0-9]+$`). Reuses the shared US sanitizer. */
function toE164(phone: string | undefined, country: string): string | undefined {
  const digits = sanitizePhone(phone, country);
  if (!digits) return undefined;
  if (country.toUpperCase() === "US") {
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  }
  return `+${digits}`;
}

/** Store pickup address — same UPS_ORIGIN_* envs as the UPS/Shippo adapters.
 * Phone lives apart: quotes only need the address; create needs the contact. */
function pickupAddressJson(): string {
  return addressJson({
    street1: process.env.UPS_ORIGIN_ADDRESS || "2760 W 84th St Unit 4",
    city: process.env.UPS_ORIGIN_CITY || "Hialeah",
    state: process.env.UPS_ORIGIN_STATE || "FL",
    zip: process.env.UPS_ORIGIN_ZIP || "33016",
    country: process.env.UPS_ORIGIN_COUNTRY || "US",
  });
}

function pickupFields(): {
  pickup_name: string;
  pickup_business_name: string;
  pickup_address: string;
  pickup_phone_number: string;
} {
  const phone = toE164(process.env.UBER_DIRECT_PICKUP_PHONE, "US");
  if (!phone) {
    throw new DispatchError(
      "not_configured",
      "UBER_DIRECT_PICKUP_PHONE (store contact for the courier) is missing or invalid"
    );
  }
  const name = process.env.UPS_ORIGIN_NAME || "Ecopowertech Inc";
  return {
    pickup_name: name,
    pickup_business_name: name,
    pickup_address: pickupAddressJson(),
    pickup_phone_number: phone,
  };
}

/** Uber wants the structured address as a JSON *string*. */
function addressJson(a: {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}): string {
  return JSON.stringify({
    street_address: [a.street1, ...(a.street2 ? [a.street2] : [])],
    city: a.city,
    state: a.state,
    zip_code: a.zip,
    country: a.country.toUpperCase(),
  });
}

function dropoffAddressJson(a: DispatchAddress): string {
  return addressJson(a);
}

/** Courier-app size bucket from box dims/weight (coarse on purpose). */
function manifestSize(p: DispatchParcel): "small" | "medium" | "large" | "xlarge" {
  const maxDim = Math.max(p.length_in, p.width_in, p.height_in);
  if (maxDim <= 12 && p.weight_lb <= 5) return "small";
  if (maxDim <= 18 && p.weight_lb <= 15) return "medium";
  if (maxDim <= 30 && p.weight_lb <= 40) return "large";
  return "xlarge";
}

interface UberQuote {
  id: string;
  fee: number;
  currency?: string;
  duration?: number; // minutes, pickup → dropoff
  dropoff_eta?: string;
}

async function requestQuote(
  creds: UberCreds,
  ctx: CreateLabelContext
): Promise<UberQuote> {
  const token = await getToken(creds);
  try {
    const res = await axios.post(
      `${API_BASE}/${creds.customerId}/delivery_quotes`,
      {
        pickup_address: pickupAddressJson(),
        dropoff_address: dropoffAddressJson(ctx.address_to),
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    const q = res.data as UberQuote;
    if (!q?.id || !Number.isFinite(q.fee)) {
      throw new Error(`unexpected quote response ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return q;
  } catch (e) {
    throw toDispatchError(e, "quote");
  }
}

/** Uber delivery status → our state machine. `pickup` = courier en route to
 * the store (nothing picked up yet); `pickup_complete` = goods on board. */
const STATUS_MAP: Record<string, DeliveryStatusUpdate["status"]> = {
  pending: "pending_pickup",
  pickup: "pending_pickup",
  pickup_complete: "in_transit",
  dropoff: "out_for_delivery",
  delivered: "delivered",
  canceled: "canceled",
  returned: "failed",
};

/** Shared by the poll path (getStatus) and the Fase 8 webhook route. Unknown
 * statuses surface as `exception` so a human looks at them. */
export function mapUberDeliveryStatus(
  uberStatus: string | undefined
): DeliveryStatusUpdate["status"] {
  return STATUS_MAP[uberStatus ?? ""] ?? "exception";
}

interface UberDelivery {
  id: string;
  status?: string;
  fee?: number;
  currency?: string;
  tracking_url?: string;
  updated?: string;
  undeliverable_reason?: string;
  dropoff?: { status_timestamp?: string };
  courier?: { name?: string };
}

export const uberDispatchAdapter: DispatchAdapter = {
  provider: "uber",

  isConfigured(): boolean {
    return Boolean(liveCreds() ?? testCreds());
  },

  async getRates(ctx: CreateLabelContext): Promise<RateOption[]> {
    const q = await requestQuote(quoteCreds(), ctx);
    return [
      {
        rate_id: q.id,
        carrier: "Uber",
        service: q.duration
          ? `Uber Direct — courier ~${q.duration} min`
          : "Uber Direct — same-day courier",
        service_token: "uber_direct",
        amount_cents: q.fee,
        currency: (q.currency ?? "usd").toUpperCase(),
        estimated_days: 0,
      },
    ];
  },

  async createLabel(ctx: CreateLabelContext): Promise<CreateLabelResult> {
    const creds = dispatchCreds();
    const pickup = pickupFields(); // throws before quoting if store phone missing
    const dropoffPhone = toE164(ctx.address_to.phone, ctx.address_to.country);
    if (!dropoffPhone) {
      throw new DispatchError(
        "invalid_address",
        "Uber Direct requires a valid customer phone number (the courier calls on arrival) — add a phone to the shipping address"
      );
    }

    // Quote → create COUPLED: quotes expire in ~15min, never reuse a stale one.
    const quote = await requestQuote(creds, ctx);

    const body: Record<string, unknown> = {
      quote_id: quote.id,
      ...pickup,
      dropoff_name: ctx.address_to.name,
      ...(ctx.address_to.company ? { dropoff_business_name: ctx.address_to.company } : {}),
      dropoff_address: dropoffAddressJson(ctx.address_to),
      dropoff_phone_number: dropoffPhone,
      manifest_items: ctx.parcels.map((p, i) => ({
        name: ctx.reference
          ? `Order ${ctx.reference} — box ${i + 1}/${ctx.parcels.length}`
          : `Box ${i + 1}/${ctx.parcels.length}`,
        quantity: 1,
        size: manifestSize(p),
      })),
      ...(ctx.reference ? { manifest_reference: ctx.reference.slice(0, 64) } : {}),
      external_id: ctx.order_id,
      // Uber-side dedupe (~60min window): a crash between the create call and
      // our persist can never dispatch two couriers on retry.
      ...(ctx.idempotency_key ? { idempotency_key: ctx.idempotency_key } : {}),
      ...(creds.mode === "test"
        ? { test_specifications: { robo_courier_specification: { mode: "auto" } } }
        : {}),
    };

    let d: UberDelivery;
    try {
      const token = await getToken(creds);
      const res = await axios.post(`${API_BASE}/${creds.customerId}/deliveries`, body, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      });
      d = res.data as UberDelivery;
    } catch (e) {
      throw toDispatchError(e, "create");
    }
    if (!d?.id) {
      throw new DispatchError(
        "provider_error",
        `Uber create returned no delivery id (got ${JSON.stringify(d).slice(0, 300)})`
      );
    }

    return {
      provider: "uber",
      provider_object_id: d.id,
      carrier: "Uber",
      service: "Uber Direct",
      // No parcel tracking number exists — the delivery id is the reference
      // shown on the invoice; the live tracking_url is the customer-facing bit.
      tracking_number: d.id,
      tracking_url: d.tracking_url ?? null,
      label_url: null, // couriers carry boxes, not labels
      rate_amount_cents: Number.isFinite(d.fee) ? (d.fee as number) : quote.fee,
      rate_currency: (d.currency ?? quote.currency ?? "usd").toUpperCase(),
      packages: [
        {
          provider_object_id: d.id,
          tracking_number: d.id,
          tracking_url: d.tracking_url ?? null,
          label_url: null,
        },
      ],
      raw: {
        quote_id: quote.id,
        status: d.status ?? "pending",
        mode: creds.mode,
        dropoff_eta: quote.dropoff_eta ?? null,
      },
    };
  },

  async getStatus(providerObjectId: string): Promise<DeliveryStatusUpdate> {
    const creds = dispatchCreds();
    let d: UberDelivery;
    try {
      const token = await getToken(creds);
      const res = await axios.get(
        `${API_BASE}/${creds.customerId}/deliveries/${encodeURIComponent(providerObjectId)}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
      );
      d = res.data as UberDelivery;
    } catch (e) {
      throw toDispatchError(e, "status");
    }
    const status = mapUberDeliveryStatus(d.status);
    return {
      status,
      detail: [
        `uber:${d.status ?? "unknown"}`,
        d.undeliverable_reason || null,
        d.courier?.name ? `courier ${d.courier.name}` : null,
      ]
        .filter(Boolean)
        .join(" — "),
      delivered_at:
        status === "delivered"
          ? (d.dropoff?.status_timestamp ?? d.updated ?? null)
          : null,
    };
  },

  /** Cancel the courier. Idempotent: an already-canceled delivery is success. */
  async voidLabel(providerObjectId: string): Promise<void> {
    const creds = dispatchCreds();
    try {
      const token = await getToken(creds);
      await axios.post(
        `${API_BASE}/${creds.customerId}/deliveries/${encodeURIComponent(providerObjectId)}/cancel`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
      );
    } catch (e) {
      const err = toDispatchError(e, "cancel");
      if (/already.*cancel|cancel.*already|noncancelable_delivery.*canceled/i.test(err.message)) {
        return;
      }
      throw err;
    }
  },
};
