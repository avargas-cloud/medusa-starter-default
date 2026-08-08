/**
 * src/lib/shipping-dispatch/shippo-adapter.ts
 *
 * Shippo dispatch adapter (plan §Fase 1). Buys parcel labels via Shippo but
 * ALWAYS selects the UPS carrier rate from the returned rate list (plan §2):
 * the UPS rate is the price source of truth, so a future swap to UPS-direct
 * changes nothing the customer sees. Status polling is NOT done here — parcel
 * tracking reuses lib/carrier-tracking by tracking number.
 *
 * Token selection is SAFE-BY-DEFAULT: the live token is only used when
 * SHIPPO_MODE=live (set in Railway). Anywhere else (local dev pointing at the
 * prod DB, sandbox) uses the test token — a bug can never buy a real label.
 */

import type {
  CreateLabelContext,
  CreateLabelResult,
  DispatchAdapter,
  DispatchAddress,
  LabelPackage,
  RateOption,
} from "./types";
import { DispatchError } from "./types";
import { sanitizePhone } from "./phone";

const SHIPPO_API = "https://api.goshippo.com";

interface ShippoAddressPayload {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

interface ShippoRate {
  object_id: string;
  provider: string; // carrier display name, e.g. "UPS"
  servicelevel: { name: string | null; token: string | null };
  amount: string; // decimal string, e.g. "12.34"
  currency: string;
  estimated_days: number | null;
}

interface ShippoShipment {
  object_id: string;
  rates: ShippoRate[];
  messages?: { text?: string; code?: string }[];
}

interface ShippoTransaction {
  object_id: string;
  status: "SUCCESS" | "ERROR" | "QUEUED" | "WAITING";
  tracking_number: string | null;
  tracking_url_provider: string | null;
  label_url: string | null;
  messages?: { text?: string; code?: string }[];
  rate: string | ShippoRate;
}

function shippoToken(): string | null {
  const live = process.env.SHIPPO_API_TOKEN?.trim();
  const test = process.env.SHIPPO_TEST_TOKEN?.trim();
  if (process.env.SHIPPO_MODE === "live") return live || null;
  return test || null;
}

async function shippoFetch<T>(
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const token = shippoToken();
  if (!token) {
    throw new DispatchError("not_configured", "Shippo token missing");
  }
  const res = await fetch(`${SHIPPO_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || json === null) {
    throw new DispatchError(
      "provider_error",
      `Shippo ${path} → HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 400)}`
    );
  }
  return json;
}

/** Warehouse origin — same env/defaults as the UPS rate preview route. */
function originAddress(): ShippoAddressPayload {
  return {
    name: process.env.UPS_ORIGIN_NAME || "Ecopowertech Inc",
    street1: process.env.UPS_ORIGIN_ADDRESS || "2760 W 84th St Unit 4",
    city: process.env.UPS_ORIGIN_CITY || "Hialeah",
    state: process.env.UPS_ORIGIN_STATE || "FL",
    zip: process.env.UPS_ORIGIN_ZIP || "33016",
    country: process.env.UPS_ORIGIN_COUNTRY || "US",
  };
}

function toShippoAddress(a: DispatchAddress): ShippoAddressPayload {
  return {
    name: a.name,
    company: a.company,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country,
    phone: sanitizePhone(a.phone, a.country),
    email: a.email,
  };
}

function centsFromAmount(amount: string): number {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) {
    throw new DispatchError("provider_error", `Bad Shippo amount "${amount}"`);
  }
  return Math.round(n * 100);
}

function toRateOption(r: ShippoRate): RateOption {
  return {
    rate_id: r.object_id,
    carrier: r.provider,
    service: r.servicelevel?.name ?? r.servicelevel?.token ?? "unknown",
    service_token: r.servicelevel?.token ?? "",
    amount_cents: centsFromAmount(r.amount),
    currency: r.currency,
    estimated_days: r.estimated_days ?? null,
  };
}

async function createShipment(ctx: CreateLabelContext): Promise<ShippoShipment> {
  return shippoFetch<ShippoShipment>("/shipments/", {
    address_from: originAddress(),
    address_to: toShippoAddress(ctx.address_to),
    parcels: ctx.parcels.map((p) => ({
      length: String(p.length_in),
      width: String(p.width_in),
      height: String(p.height_in),
      distance_unit: "in",
      weight: String(p.weight_lb),
      mass_unit: "lb",
    })),
    // Join key for polls/reconciliation (plan §4).
    metadata: ctx.order_id,
    async: false,
  });
}

/** UPS rates only (plan §2 rate rule), cheapest first.
 *
 * TEST-mode relaxation: Shippo's shared test account barely offers UPS (its
 * default carrier is shippo_usps_master, frequently throttled), so enforcing
 * UPS-only in the sandbox turns every quote into `no_ups_rate` and the
 * Delivery flow becomes untestable. When SHIPPO_MODE != 'live' we fall back
 * to WHATEVER carriers the test account returned if no UPS rate exists.
 * Production (SHIPPO_MODE=live on Railway) keeps the strict UPS rule. */
function upsRates(shipment: ShippoShipment): ShippoRate[] {
  const all = (shipment.rates ?? []).sort(
    (a, b) => centsFromAmount(a.amount) - centsFromAmount(b.amount)
  );
  const ups = all.filter((r) => r.provider?.toUpperCase() === "UPS");
  if (ups.length === 0 && process.env.SHIPPO_MODE !== "live" && all.length > 0) {
    return all;
  }
  return ups;
}

function noUpsRateError(shipment: ShippoShipment, service?: string): DispatchError {
  const carriers = [...new Set((shipment.rates ?? []).map((r) => r.provider))];
  const msgs = (shipment.messages ?? [])
    .map((m) => m.text)
    .filter(Boolean)
    .join("; ");
  return new DispatchError(
    "no_ups_rate",
    `No UPS rate${service ? ` for service "${service}"` : ""} (carriers returned: ${carriers.join(", ") || "none"}${msgs ? `; ${msgs}` : ""})`
  );
}

function pickRate(shipment: ShippoShipment, service?: string): ShippoRate {
  const ups = upsRates(shipment);
  const chosen = service
    ? ups.find((r) => r.servicelevel?.token === service)
    : ups[0];
  if (!chosen) {
    throw noUpsRateError(shipment, service);
  }
  return chosen;
}

export const shippoAdapter: DispatchAdapter = {
  provider: "shippo",

  isConfigured(): boolean {
    return Boolean(shippoToken());
  },

  async getRates(ctx: CreateLabelContext): Promise<RateOption[]> {
    const shipment = await createShipment(ctx);
    const ups = upsRates(shipment);
    if (ups.length === 0) {
      // Surface WHY (carrier messages) instead of a silent empty list.
      throw noUpsRateError(shipment);
    }
    return ups.map(toRateOption);
  },

  async createLabel(ctx: CreateLabelContext): Promise<CreateLabelResult> {
    // The buy re-quotes (fresh shipment) before purchasing. Carrier rate
    // endpoints throttle ("Too Many Requests") — on Shippo's shared TEST
    // account constantly, and occasionally live — which surfaced as
    // "quote showed UPS Ground, Buy said no_ups_rate" seconds later. Retry
    // the QUOTE step (nothing is purchased yet, so retrying is free) up to
    // twice with a short backoff before giving up.
    let shipment = await createShipment(ctx);
    let rate: ShippoRate | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        rate = pickRate(shipment, ctx.service);
        break;
      } catch (err) {
        const throttled = (shipment.messages ?? []).some((m) =>
          /too many requests/i.test(m.text ?? "")
        );
        if (!(err instanceof DispatchError) || !throttled || attempt >= 2) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        shipment = await createShipment(ctx);
      }
    }

    const txn = await shippoFetch<ShippoTransaction>("/transactions/", {
      rate: rate.object_id,
      label_file_type: "PDF_4x6",
      metadata: ctx.order_id,
      async: false,
    });

    if (txn.status !== "SUCCESS" || !txn.tracking_number) {
      const msgs = (txn.messages ?? [])
        .map((m) => m.text)
        .filter(Boolean)
        .join("; ");
      throw new DispatchError(
        "provider_error",
        `Shippo transaction ${txn.object_id ?? "?"} status=${txn.status}${msgs ? `: ${msgs}` : ""}`
      );
    }

    // UPS multi-piece: ONE purchase mints one transaction PER PARCEL. List
    // them all so every box gets its tracking + label persisted (buying only
    // surfaces the master). Non-fatal: fall back to the master transaction.
    let packages: LabelPackage[] = [
      {
        provider_object_id: txn.object_id,
        tracking_number: txn.tracking_number,
        tracking_url: txn.tracking_url_provider ?? null,
        label_url: txn.label_url ?? null,
      },
    ];
    if (ctx.parcels.length > 1) {
      try {
        const list = await shippoFetch<{ results: ShippoTransaction[] }>(
          `/transactions?rate=${rate.object_id}&results=${ctx.parcels.length + 5}`
        );
        const ok = (list.results ?? []).filter(
          (t) => t.status === "SUCCESS" && t.tracking_number
        );
        if (ok.length >= packages.length) {
          packages = ok.map((t) => ({
            provider_object_id: t.object_id,
            tracking_number: t.tracking_number as string,
            tracking_url: t.tracking_url_provider ?? null,
            label_url: t.label_url ?? null,
          }));
        }
      } catch {
        // keep master-only fallback
      }
    }

    return {
      provider: "shippo",
      provider_object_id: txn.object_id,
      carrier: "UPS",
      service: rate.servicelevel?.name ?? rate.servicelevel?.token ?? null,
      tracking_number: txn.tracking_number,
      tracking_url: txn.tracking_url_provider ?? null,
      label_url: txn.label_url ?? null,
      rate_amount_cents: centsFromAmount(rate.amount),
      rate_currency: rate.currency,
      packages,
      raw: {
        shipment_object_id: shipment.object_id,
        rate_object_id: rate.object_id,
        servicelevel_token: rate.servicelevel?.token ?? null,
      },
    };
  },

  /** Refund the label. Shippo refunds are async server-side; QUEUED counts
   * as accepted. Idempotent: an already-refunded transaction errors with a
   * message Shippo returns — surfaced as provider_error for the route. */
  async voidLabel(providerObjectId: string): Promise<void> {
    await shippoFetch<{ object_id: string; status: string }>("/refunds/", {
      transaction: providerObjectId,
      async: false,
    });
  },
};
