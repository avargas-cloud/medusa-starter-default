/**
 * src/lib/shipping-dispatch/ups-adapter.ts
 *
 * UPS-direct dispatch adapter (plan §Fase 2). Reuses the SAME UPS Developer
 * app (OAuth via lib/carrier-tracking/ups.ts) already serving PO tracking and
 * web rating — the app needs the "Shipping" product added (401 code 250002
 * from /shipments = product missing, NOT bad credentials).
 *
 * Rates: Rating API v2409 "Shop" with NegotiatedRatesIndicator — the account's
 * negotiated rate is preferred over published (verified live: Ground $23.12 vs
 * $25.51). Rating is read-only and always hits prod.
 *
 * Labels: Ship API v2409. SAFE-BY-DEFAULT like Shippo: shipments/void hit the
 * UPS CIE test host unless UPS_SHIP_MODE=live (set in Railway) — a bug can
 * never buy a real label from dev. UPS returns the label INLINE as base64 GIF
 * (no CDN URL) → exposed via LabelPackage.label_base64 for the re-host step.
 *
 * service_token vocabulary matches Shippo's (ups_ground, ups_3_day_select, …)
 * so the POS modal + saved deliveries stay provider-agnostic (plan §Fase 2:
 * "intercambiable vía el registry").
 */

import axios from "axios";

import { getUpsOauthToken } from "../carrier-tracking/ups";
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

const PROD_API = "https://onlinetools.ups.com/api";
const CIE_API = "https://wwwcie.ups.com/api";
const VERSION = "v2409";

/** Ship/void are money-moving → CIE unless explicitly live. Rating is free. */
function shipApiBase(): string {
  return process.env.UPS_SHIP_MODE === "live" ? PROD_API : CIE_API;
}

/** UPS service code ↔ Shippo-parity token (POS stays provider-agnostic). */
const SERVICES: { code: string; token: string; name: string }[] = [
  { code: "03", token: "ups_ground", name: "UPS Ground" },
  { code: "12", token: "ups_3_day_select", name: "UPS 3 Day Select" },
  { code: "02", token: "ups_second_day_air", name: "UPS 2nd Day Air" },
  { code: "59", token: "ups_second_day_air_am", name: "UPS 2nd Day Air A.M." },
  { code: "13", token: "ups_next_day_air_saver", name: "UPS Next Day Air Saver" },
  { code: "01", token: "ups_next_day_air", name: "UPS Next Day Air" },
  { code: "14", token: "ups_next_day_air_early_am", name: "UPS Next Day Air Early" },
];

const byCode = new Map(SERVICES.map((s) => [s.code, s]));
const byToken = new Map(SERVICES.map((s) => [s.token, s]));

function upsHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    transId: `dispatch_${Date.now()}`,
    transactionSrc: "medusa-shipping-dispatch",
  };
}

interface UpsAddressNode {
  Name: string;
  AttentionName?: string;
  Phone?: { Number: string };
  Address: {
    AddressLine: string[];
    City: string;
    StateProvinceCode: string;
    PostalCode: string;
    CountryCode: string;
  };
}

function shipperNumber(): string {
  return process.env.UPS_SHIPPER_NUMBER?.trim() ?? "";
}

/** Warehouse origin — same env/defaults as the Shippo adapter + rate route. */
function originNode(): UpsAddressNode {
  return {
    Name: process.env.UPS_ORIGIN_NAME || "Ecopowertech Inc",
    Address: {
      AddressLine: [process.env.UPS_ORIGIN_ADDRESS || "2760 W 84th St Unit 4"],
      City: process.env.UPS_ORIGIN_CITY || "Hialeah",
      StateProvinceCode: process.env.UPS_ORIGIN_STATE || "FL",
      PostalCode: process.env.UPS_ORIGIN_ZIP || "33016",
      CountryCode: process.env.UPS_ORIGIN_COUNTRY || "US",
    },
  };
}

function toNode(a: DispatchAddress): UpsAddressNode {
  const phone = sanitizePhone(a.phone, a.country);
  return {
    Name: (a.company || a.name).slice(0, 35),
    AttentionName: a.name.slice(0, 35),
    ...(phone ? { Phone: { Number: phone } } : {}),
    Address: {
      AddressLine: [a.street1, ...(a.street2 ? [a.street2] : [])],
      City: a.city,
      StateProvinceCode: a.state,
      PostalCode: a.zip,
      CountryCode: a.country.toUpperCase(),
    },
  };
}

function packageNodes(ctx: CreateLabelContext): Record<string, unknown>[] {
  return ctx.parcels.map((p) => ({
    // Ship API calls this "Packaging"; Rating calls it "PackagingType".
    Packaging: { Code: "02" },
    Dimensions: {
      UnitOfMeasurement: { Code: "IN" },
      Length: String(Math.max(1, Math.ceil(p.length_in))),
      Width: String(Math.max(1, Math.ceil(p.width_in))),
      Height: String(Math.max(1, Math.ceil(p.height_in))),
    },
    PackageWeight: {
      UnitOfMeasurement: { Code: "LBS" },
      Weight: Math.max(0.1, p.weight_lb).toFixed(1),
    },
    ...(ctx.reference ? { ReferenceNumber: { Value: ctx.reference.slice(0, 35) } } : {}),
  }));
}

function centsFrom(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Extract UPS error list into a DispatchError. 401 250002 = product missing. */
function toDispatchError(e: unknown, op: string): DispatchError {
  const ax = e as {
    response?: {
      status?: number;
      data?: { response?: { errors?: { code?: string; message?: string }[] } };
    };
    message?: string;
  };
  const errors = ax.response?.data?.response?.errors ?? [];
  const msg = errors.map((x) => `${x.code} ${x.message}`).join("; ") || ax.message || "unknown";
  if (ax.response?.status === 401 && errors.some((x) => x.code === "250002")) {
    return new DispatchError(
      "not_configured",
      `UPS ${op}: app is not authorized for this API — add the "Shipping" product to the UPS Developer app (${msg})`
    );
  }
  return new DispatchError("provider_error", `UPS ${op} failed: ${msg}`);
}

interface RatedShipment {
  Service?: { Code?: string };
  TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string };
  NegotiatedRateCharges?: { TotalCharge?: { MonetaryValue?: string; CurrencyCode?: string } };
  GuaranteedDelivery?: { BusinessDaysInTransit?: string };
}

async function shopRates(ctx: CreateLabelContext): Promise<RateOption[]> {
  const token = await getUpsOauthToken();
  const body = {
    RateRequest: {
      Request: { TransactionReference: { CustomerContext: ctx.order_id } },
      Shipment: {
        Shipper: { ...originNode(), ShipperNumber: shipperNumber() },
        ShipTo: toNode(ctx.address_to),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
        Package: packageNodes(ctx).map(({ Packaging, ...rest }) => ({
          PackagingType: Packaging,
          ...rest,
        })),
      },
    },
  };
  let rated: RatedShipment | RatedShipment[] | undefined;
  try {
    const res = await axios.post(`${PROD_API}/rating/${VERSION}/Shop`, body, {
      headers: upsHeaders(token),
      timeout: 20000,
    });
    rated = res.data?.RateResponse?.RatedShipment;
  } catch (e) {
    throw toDispatchError(e, "rating");
  }
  const list = (Array.isArray(rated) ? rated : rated ? [rated] : [])
    .map((r): RateOption | null => {
      const code = r.Service?.Code ?? "";
      const svc = byCode.get(code);
      if (!svc) return null; // international/freight codes — not offered
      const cents =
        centsFrom(r.NegotiatedRateCharges?.TotalCharge?.MonetaryValue) ??
        centsFrom(r.TotalCharges?.MonetaryValue);
      if (cents === null) return null;
      const days = Number.parseInt(r.GuaranteedDelivery?.BusinessDaysInTransit ?? "", 10);
      return {
        rate_id: `ups_${code}`,
        carrier: "UPS",
        service: svc.name,
        service_token: svc.token,
        amount_cents: cents,
        currency:
          r.NegotiatedRateCharges?.TotalCharge?.CurrencyCode ??
          r.TotalCharges?.CurrencyCode ??
          "USD",
        estimated_days: Number.isFinite(days) ? days : null,
      };
    })
    .filter((r): r is RateOption => r !== null)
    .sort((a, b) => a.amount_cents - b.amount_cents);
  if (list.length === 0) {
    throw new DispatchError("no_ups_rate", "UPS returned no usable rates for this shipment");
  }
  return list;
}

interface UpsPackageResult {
  TrackingNumber?: string;
  ShippingLabel?: { ImageFormat?: { Code?: string }; GraphicImage?: string };
}

const MIME_BY_FORMAT: Record<string, string> = {
  GIF: "image/gif",
  PNG: "image/png",
  PDF: "application/pdf",
};

function trackingUrl(num: string): string {
  return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(num)}`;
}

export const upsDispatchAdapter: DispatchAdapter = {
  provider: "ups",

  isConfigured(): boolean {
    return Boolean(
      process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET && shipperNumber()
    );
  },

  async getRates(ctx: CreateLabelContext): Promise<RateOption[]> {
    return shopRates(ctx);
  },

  async createLabel(ctx: CreateLabelContext): Promise<CreateLabelResult> {
    // Resolve service: explicit token, else cheapest from a live Shop quote.
    let service = ctx.service ? byToken.get(ctx.service) : undefined;
    if (ctx.service && !service) {
      throw new DispatchError("no_ups_rate", `Unknown UPS service token "${ctx.service}"`);
    }
    if (!service) {
      const cheapest = (await shopRates(ctx))[0]!;
      service = byToken.get(cheapest.service_token)!;
    }

    const token = await getUpsOauthToken();
    const body = {
      ShipmentRequest: {
        Request: {
          RequestOption: "nonvalidate",
          TransactionReference: { CustomerContext: ctx.order_id },
        },
        Shipment: {
          Shipper: { ...originNode(), ShipperNumber: shipperNumber() },
          ShipTo: toNode(ctx.address_to),
          PaymentInformation: {
            ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: shipperNumber() } },
          },
          Service: { Code: service.code },
          ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
          Package: packageNodes(ctx),
        },
        LabelSpecification: {
          LabelImageFormat: { Code: "GIF" },
          HTTPUserAgent: "Mozilla/4.5",
        },
      },
    };

    let results: {
      ShipmentIdentificationNumber?: string;
      ShipmentCharges?: { TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string } };
      NegotiatedRateCharges?: { TotalCharge?: { MonetaryValue?: string; CurrencyCode?: string } };
      PackageResults?: UpsPackageResult | UpsPackageResult[];
    };
    try {
      const res = await axios.post(`${shipApiBase()}/shipments/${VERSION}/ship`, body, {
        headers: upsHeaders(token),
        timeout: 30000,
      });
      results = res.data?.ShipmentResponse?.ShipmentResults ?? {};
    } catch (e) {
      throw toDispatchError(e, "ship");
    }

    const shipmentId = results.ShipmentIdentificationNumber;
    const pkgRaw = results.PackageResults;
    const pkgList = Array.isArray(pkgRaw) ? pkgRaw : pkgRaw ? [pkgRaw] : [];
    if (!shipmentId || pkgList.length === 0 || !pkgList[0]?.TrackingNumber) {
      throw new DispatchError(
        "provider_error",
        `UPS ship returned no shipment id / packages (got ${JSON.stringify(results).slice(0, 300)})`
      );
    }

    const packages: LabelPackage[] = pkgList.map((p, i) => {
      const num = p.TrackingNumber ?? `${shipmentId}_${i + 1}`;
      const fmt = p.ShippingLabel?.ImageFormat?.Code?.toUpperCase() ?? "GIF";
      return {
        provider_object_id: num,
        tracking_number: num,
        tracking_url: trackingUrl(num),
        label_url: null, // UPS returns the label inline, not hosted
        label_base64: p.ShippingLabel?.GraphicImage ?? null,
        label_mime: MIME_BY_FORMAT[fmt] ?? "image/gif",
      };
    });

    const cents =
      centsFrom(results.NegotiatedRateCharges?.TotalCharge?.MonetaryValue) ??
      centsFrom(results.ShipmentCharges?.TotalCharges?.MonetaryValue) ??
      0;

    return {
      provider: "ups",
      provider_object_id: shipmentId,
      carrier: "UPS",
      service: service.name,
      tracking_number: packages[0]!.tracking_number,
      tracking_url: packages[0]!.tracking_url,
      label_url: null,
      rate_amount_cents: cents,
      rate_currency:
        results.NegotiatedRateCharges?.TotalCharge?.CurrencyCode ??
        results.ShipmentCharges?.TotalCharges?.CurrencyCode ??
        "USD",
      packages,
      raw: { shipment_identification_number: shipmentId, service_code: service.code },
    };
  },

  /** Void the whole shipment. Idempotent: "already voided" counts as success. */
  async voidLabel(providerObjectId: string): Promise<void> {
    const token = await getUpsOauthToken();
    try {
      await axios.delete(
        `${shipApiBase()}/shipments/${VERSION}/void/cancel/${encodeURIComponent(providerObjectId)}`,
        { headers: upsHeaders(token), timeout: 20000 }
      );
    } catch (e) {
      const err = toDispatchError(e, "void");
      if (/already.*void/i.test(err.message)) return;
      throw err;
    }
  },
};
