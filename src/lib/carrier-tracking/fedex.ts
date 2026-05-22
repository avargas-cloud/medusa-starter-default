/**
 * src/lib/carrier-tracking/fedex.ts
 *
 * FedEx Track API adapter ("Basic Integrated Visibility", formerly Track API).
 * OAuth client_credentials against apis.fedex.com.
 *
 * Docs: https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
 *   POST /oauth/token
 *   POST /track/v1/trackingnumbers
 */

import axios from "axios";

import type { CarrierAdapter, CarrierTrackingResult } from "./types";
import { errored, unavailable } from "./types";

const BASE = "https://apis.fedex.com";

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const id = process.env.FEDEX_CLIENT_ID;
  const secret = process.env.FEDEX_CLIENT_SECRET;
  if (!id || !secret) throw new Error("FedEx credentials not configured");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });
  const res = await axios.post(`${BASE}/oauth/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  cachedToken = res.data.access_token as string;
  const expiresIn = Number(res.data.expires_in ?? 3600);
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
}

/** FedEx dateTime is ISO (may carry tz/offset) → ISO date YYYY-MM-DD. */
function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    // Some FedEx dates come as "2026-05-26" already.
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  }
  return d.toISOString().slice(0, 10);
}

interface FedexDateAndTime {
  type?: string;
  dateTime?: string;
}
interface FedexTrackResult {
  latestStatusDetail?: {
    code?: string;
    statusByLocale?: string;
    description?: string;
  };
  dateAndTimes?: FedexDateAndTime[];
  estimatedDeliveryTimeWindow?: { window?: { ends?: string } };
  error?: { message?: string };
}

export const fedexAdapter: CarrierAdapter = {
  provider: "FedEx",

  isConfigured() {
    return Boolean(
      process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET
    );
  },

  async track(trackingNumber: string): Promise<CarrierTrackingResult> {
    if (!this.isConfigured()) return unavailable("FedEx API not configured");

    try {
      const token = await getToken();
      const res = await axios.post(
        `${BASE}/track/v1/trackingnumbers`,
        {
          includeDetailedScans: false,
          trackingInfo: [
            { trackingNumberInfo: { trackingNumber: trackingNumber.trim() } },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-locale": "en_US",
          },
          timeout: 15000,
        }
      );

      const result: FedexTrackResult | undefined =
        res.data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
      if (!result) return unavailable("No tracking detail from FedEx yet");

      if (result.error?.message) {
        return unavailable(result.error.message);
      }

      const code = result.latestStatusDetail?.code; // "DL" = delivered
      const statusText =
        result.latestStatusDetail?.statusByLocale ??
        result.latestStatusDetail?.description ??
        null;

      const actualDelivery = result.dateAndTimes?.find(
        (d) => d.type === "ACTUAL_DELIVERY"
      );
      if (code === "DL" || actualDelivery) {
        return {
          estimated_delivery: null,
          status: "delivered",
          detail: statusText,
        };
      }

      const estimated =
        result.dateAndTimes?.find((d) => d.type === "ESTIMATED_DELIVERY")
          ?.dateTime ?? result.estimatedDeliveryTimeWindow?.window?.ends;

      return {
        estimated_delivery: toIsoDate(estimated),
        status: "in_transit",
        detail: statusText,
      };
    } catch (e: unknown) {
      const ax = e as { response?: { status?: number }; message?: string };
      if (ax.response?.status === 404) {
        return unavailable("FedEx has no record yet (awaiting first scan)");
      }
      return errored(ax.message ?? "FedEx lookup failed");
    }
  },
};
