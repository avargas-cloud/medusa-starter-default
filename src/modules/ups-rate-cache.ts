import axios from "axios";

import { PackageSpec } from "./box-packing";

interface CachedRates {
  rates: Record<string, number>; // serviceCode -> price in cents
  timestamp: number;
}

interface ShopRateRequest {
  cartId: string;
  postalCode: string;
  packages: PackageSpec[]; // one or more packages (from box-packing)
  shipperZip: string;
  shipperAddress: string;
  shipperCity: string;
  shipperState: string;
  shipperCountry: string;
  shipperName: string;
  shipToName: string;
  shipToAddress: string;
  shipToCity: string;
  shipToState: string;
  shipToCountry: string;
}

// Singleton cache — shared across all UPS provider instances in the same Node.js process
const rateCache = new Map<string, CachedRates>();
const CACHE_TTL_MS = 30_000; // 30 seconds

// Singleton OAuth token — shared across all providers
let sharedAccessToken: string | null = null;
let sharedTokenExpiry: number = 0;

// In-flight promise deduplication — if multiple providers call simultaneously, only one HTTP request fires
const inFlightRequests = new Map<string, Promise<Record<string, number>>>();

function getCacheKey(
  cartId: string,
  postalCode: string,
  pkgCount: number
): string {
  return `${cartId}:${postalCode}:${pkgCount}`;
}

async function getAccessToken(): Promise<string> {
  if (sharedAccessToken && Date.now() < sharedTokenExpiry) {
    return sharedAccessToken;
  }

  const clientId = process.env.UPS_CLIENT_ID!;
  const clientSecret = process.env.UPS_CLIENT_SECRET!;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await axios.post(
    "https://onlinetools.ups.com/security/v1/oauth/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  sharedAccessToken = response.data.access_token;
  sharedTokenExpiry = Date.now() + 3500 * 1000; // cache for 3500s (token valid 3600s)
  return sharedAccessToken!;
}

// Country codes that might accidentally arrive as the "state" field
const COUNTRY_CODES = new Set([
  "US",
  "CA",
  "MX",
  "GB",
  "AU",
  "DE",
  "FR",
  "ES",
  "IT",
  "BR",
]);

/**
 * Derive US state from ZIP code prefix.
 * Used as fallback when `province` field contains a country code instead of state.
 */
function zipToUsState(zip: string): string {
  const n = parseInt(zip?.slice(0, 3) ?? "0", 10);
  if (n >= 990) return "AK";
  if (n >= 988) return "WA";
  if (n >= 970) return "OR";
  if (n >= 900) return "CA";
  if (n >= 850) return "AZ";
  if (n >= 830) return "ID";
  if (n >= 820) return "WY";
  if (n >= 800) return "CO";
  if (n >= 787) return "TX";
  if (n >= 780) return "TX";
  if (n >= 770) return "TX";
  if (n >= 760) return "TX";
  if (n >= 750) return "TX";
  if (n >= 730) return "OK";
  if (n >= 700) return "LA";
  if (n >= 690) return "NE";
  if (n >= 680) return "NE";
  if (n >= 670) return "KS";
  if (n >= 660) return "KS";
  if (n >= 650) return "MO";
  if (n >= 630) return "MO";
  if (n >= 620) return "IL";
  if (n >= 600) return "IL";
  if (n >= 590) return "MT";
  if (n >= 580) return "ND";
  if (n >= 570) return "SD";
  if (n >= 560) return "MN";
  if (n >= 550) return "MN";
  if (n >= 540) return "WI";
  if (n >= 530) return "WI";
  if (n >= 520) return "IA";
  if (n >= 500) return "IA";
  if (n >= 490) return "MI";
  if (n >= 480) return "MI";
  if (n >= 470) return "IN";
  if (n >= 460) return "IN";
  if (n >= 450) return "OH";
  if (n >= 430) return "OH";
  if (n >= 420) return "KY";
  if (n >= 400) return "KY";
  if (n >= 397) return "MS";
  if (n >= 386) return "MS";
  if (n >= 380) return "TN";
  if (n >= 370) return "TN";
  if (n >= 360) return "AL";
  if (n >= 350) return "AL";
  if (n >= 320) return "FL";
  if (n >= 300) return "GA";
  if (n >= 290) return "SC";
  if (n >= 280) return "NC";
  if (n >= 270) return "NC";
  if (n >= 260) return "WV";
  if (n >= 250) return "WV";
  if (n >= 240) return "VA";
  if (n >= 220) return "VA";
  if (n >= 210) return "MD";
  if (n >= 200) return "DC";
  if (n >= 190) return "PA";
  if (n >= 150) return "PA";
  if (n >= 140) return "NY";
  if (n >= 100) return "NY";
  if (n >= 90) return "MA";
  if (n >= 60) return "CT";
  if (n >= 50) return "RI";
  if (n >= 30) return "NH";
  if (n >= 20) return "MA";
  if (n >= 10) return "NJ";
  return "ME";
}

/**
 * Sanitize state/province for UPS API.
 * Handles:
 * - Duplicate state codes: "FLFL" → "FL"
 * - Country codes arriving as state: "US" → derived from ZIP
 */
function sanitizeState(state: string, postalCode?: string): string {
  if (!state) return "";
  const trimmed = state.trim().toUpperCase();

  // Handle Medusa province format: "us-fl", "US-FL", "us-florida" → extract part after "-"
  if (trimmed.includes("-")) {
    const parts = trimmed.split("-");
    // "US-FL" → ["US","FL"] → take last non-empty part (the state)
    const statePart = (parts[parts.length - 1] ?? "").trim();
    if (statePart.length === 2) {
      console.log(
        `📍 sanitizeState: Medusa format "${trimmed}" → "${statePart}"`
      );
      return statePart;
    }
    // "us-florida" → "FLORIDA" (too long, try first 2 chars of last segment)
    if (statePart.length > 2) {
      const abbrev = statePart.slice(0, 2);
      console.log(
        `📍 sanitizeState: Medusa long format "${trimmed}" → "${abbrev}"`
      );
      return abbrev;
    }
  }

  // Plain country code sent as state (e.g., province was not set and country_code leaked)
  if (COUNTRY_CODES.has(trimmed)) {
    if (trimmed === "US" && postalCode) {
      const derived = zipToUsState(postalCode ?? "");
      console.warn(
        `⚠️  sanitizeState: country code "${trimmed}" as state → derived "${derived}" from ZIP ${postalCode}`
      );
      return derived;
    }
    console.warn(
      `⚠️  sanitizeState: country code "${trimmed}" as state, passing empty`
    );
    return "";
  }

  // Duplicate state bug: "FLFL" → "FL"
  return trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed;
}

async function fetchShopRates(
  req: ShopRateRequest
): Promise<Record<string, number>> {
  const token = await getAccessToken();

  const totalWeight = req.packages.reduce((s, p) => s + p.weight, 0);
  console.log(
    `🚀 UPS Shop API — cart ${req.cartId} → ${req.postalCode} | ${req.packages.length} pkg(s), ${totalWeight.toFixed(2)}lbs total`
  );

  const shopRequest = {
    RateRequest: {
      Request: {
        TransactionReference: { CustomerContext: "Shop Rate Request" },
      },
      Shipment: {
        Shipper: {
          Name: req.shipperName,
          ShipperNumber: process.env.UPS_SHIPPER_NUMBER || "",
          Address: {
            AddressLine: [req.shipperAddress],
            City: req.shipperCity,
            StateProvinceCode: sanitizeState(req.shipperState, req.shipperZip),
            PostalCode: req.shipperZip,
            CountryCode: req.shipperCountry,
          },
        },
        ShipTo: {
          Name: req.shipToName,
          Address: {
            AddressLine: [req.shipToAddress],
            City: req.shipToCity,
            StateProvinceCode: sanitizeState(req.shipToState, req.postalCode),
            PostalCode: req.postalCode,
            CountryCode: req.shipToCountry,
          },
        },
        // Multiple packages — UPS sums the cost of all packages
        Package: req.packages.map((pkg) => ({
          PackagingType: { Code: "02", Description: "Package" },
          PackageWeight: {
            UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
            Weight: pkg.weight.toFixed(2),
          },
          Dimensions: {
            UnitOfMeasurement: { Code: "IN", Description: "Inches" },
            Length: pkg.length.toFixed(2),
            Width: pkg.width.toFixed(2),
            Height: pkg.height.toFixed(2),
          },
        })),
      },
    },
  };

  try {
    const response = await axios.post(
      "https://onlinetools.ups.com/api/rating/v1/Shop",
      shopRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          transId: `shop_${Date.now()}`,
          transactionSrc: "medusa",
        },
      }
    );

    const ratedShipments = response.data.RateResponse?.RatedShipment || [];
    const rates: Record<string, number> = {};

    for (const shipment of ratedShipments) {
      const serviceCode = shipment.Service?.Code;
      if (!serviceCode) continue;

      const rateStr =
        shipment.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ||
        shipment.TotalCharges?.MonetaryValue ||
        "0";

      rates[serviceCode] = Math.round(parseFloat(rateStr) * 100); // store in cents
    }

    console.log(
      `✅ UPS Shop returned ${Object.keys(rates).length} services:`,
      rates
    );
    return rates;
  } catch (error: any) {
    console.error(
      "❌ UPS Shop API Error Dumps:",
      error.response?.data?.response?.errors ||
        error.response?.data ||
        error.message
    );
    // Re-throw so the provider catches it and marks the option unavailable
    throw error;
  }
}

/**
 * Get UPS rate for a specific service code.
 * Uses shared cache — only 1 HTTP call per cart+zip+pkgCount combo within 30 seconds.
 */
export async function getUPSRate(
  serviceCode: string,
  req: ShopRateRequest
): Promise<number | null> {
  const cacheKey = getCacheKey(req.cartId, req.postalCode, req.packages.length);

  // Check cache first
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const price = cached.rates[serviceCode];
    console.log(
      `📦 UPS cache hit for ${serviceCode} (cart ${req.cartId}): ${price} cents`
    );
    return price ?? null;
  }

  // Deduplicate in-flight requests — if another provider is already fetching, wait for it
  if (!inFlightRequests.has(cacheKey)) {
    const promise = fetchShopRates(req)
      .then((rates) => {
        rateCache.set(cacheKey, { rates, timestamp: Date.now() });
        inFlightRequests.delete(cacheKey);
        return rates;
      })
      .catch((err) => {
        inFlightRequests.delete(cacheKey);
        throw err;
      });
    inFlightRequests.set(cacheKey, promise);
  }

  const rates = await inFlightRequests.get(cacheKey)!;
  return rates[serviceCode] ?? null;
}
