/**
 * src/lib/carrier-tracking/ups.ts
 *
 * UPS Track API adapter. Reuses the same OAuth client_credentials flow as the
 * ups-shipping rate module (UPS_CLIENT_ID / UPS_CLIENT_SECRET against
 * onlinetools.ups.com), so no new credentials are required.
 *
 * Docs: https://developer.ups.com/api/reference  (Tracking)
 *   GET /api/track/v1/details/{inquiryNumber}
 */

import axios from "axios";

import type { CarrierAdapter, CarrierTrackingResult } from "./types";
import { errored, unavailable } from "./types";

const OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const TRACK_URL = "https://onlinetools.ups.com/api/track/v1/details";

// Module-level token cache (backend is a long-running process).
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const id = process.env.UPS_CLIENT_ID;
  const secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) throw new Error("UPS credentials not configured");

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await axios.post(OAUTH_URL, "grant_type=client_credentials", {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });

  cachedToken = res.data.access_token as string;
  // UPS tokens last 3600s; cache for 3500s to be safe.
  tokenExpiry = Date.now() + 3500 * 1000;
  return cachedToken;
}

/** UPS deliveryDate.date is YYYYMMDD → ISO YYYY-MM-DD. */
function parseUpsDate(raw: string | undefined): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

interface UpsDeliveryDate {
  type?: string;
  date?: string;
}
interface UpsPackage {
  currentStatus?: { type?: string; code?: string; description?: string };
  deliveryDate?: UpsDeliveryDate[];
}
interface UpsShipment {
  package?: UpsPackage[];
}

export const upsAdapter: CarrierAdapter = {
  provider: "UPS",

  isConfigured() {
    return Boolean(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);
  },

  async track(trackingNumber: string): Promise<CarrierTrackingResult> {
    if (!this.isConfigured()) return unavailable("UPS API not configured");

    try {
      const token = await getToken();
      const res = await axios.get(
        `${TRACK_URL}/${encodeURIComponent(trackingNumber.trim())}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            transId: `potrk_${Date.now()}`,
            transactionSrc: "medusa-po-tracking",
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      const shipment: UpsShipment | undefined =
        res.data?.trackResponse?.shipment?.[0];
      const pkg = shipment?.package?.[0];
      if (!pkg) return unavailable("No tracking detail from UPS yet");

      const statusType = pkg.currentStatus?.type; // "D" = delivered
      const statusDesc = pkg.currentStatus?.description ?? null;
      const delivered =
        statusType === "D" ||
        (statusDesc?.toLowerCase().includes("delivered") ?? false);

      const byType = (type: string) =>
        pkg.deliveryDate?.find((d) => d.type === type)?.date;

      if (delivered) {
        // Surface the ACTUAL delivery date (type "DEL") so Expected Delivery
        // reflects reality once the package has arrived.
        return {
          estimated_delivery: parseUpsDate(byType("DEL")),
          status: "delivered",
          detail: statusDesc,
        };
      }

      // Estimated delivery — prefer Rescheduled, then Scheduled, then Estimated.
      const raw = byType("RDD") ?? byType("SDD") ?? byType("EDD");
      const eta = parseUpsDate(raw);

      return {
        estimated_delivery: eta,
        status: "in_transit",
        detail: statusDesc,
      };
    } catch (e: unknown) {
      const ax = e as { response?: { status?: number }; message?: string };
      // 404 = number not found yet (label created, no scan) → unavailable, not error.
      if (ax.response?.status === 404) {
        return unavailable("UPS has no record yet (awaiting first scan)");
      }
      return errored(ax.message ?? "UPS lookup failed");
    }
  },
};
