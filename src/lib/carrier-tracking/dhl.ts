/**
 * src/lib/carrier-tracking/dhl.ts
 *
 * DHL "Shipment Tracking — Unified" adapter. Simple API-key auth (no OAuth):
 * the DHL-API-Key header against the EU gateway (which tracks worldwide).
 *
 * Docs: https://developer.dhl.com/api-reference/shipment-tracking
 *   GET /track/shipments?trackingNumber={num}
 */

import axios from "axios";

import type { CarrierAdapter, CarrierTrackingResult } from "./types";
import { errored, unavailable } from "./types";

const TRACK_URL = "https://api-eu.dhl.com/track/shipments";

function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  }
  return d.toISOString().slice(0, 10);
}

interface DhlShipment {
  status?: { statusCode?: string; status?: string; description?: string };
  estimatedTimeOfDelivery?: string;
  estimatedDeliveryTimeFrame?: {
    estimatedThrough?: string;
    estimatedFrom?: string;
  };
}

export const dhlAdapter: CarrierAdapter = {
  provider: "DHL",

  isConfigured() {
    return Boolean(process.env.DHL_API_KEY);
  },

  async track(trackingNumber: string): Promise<CarrierTrackingResult> {
    if (!this.isConfigured()) return unavailable("DHL API not configured");

    try {
      const res = await axios.get(TRACK_URL, {
        params: { trackingNumber: trackingNumber.trim() },
        headers: { "DHL-API-Key": process.env.DHL_API_KEY as string },
        timeout: 15000,
      });

      const shipment: DhlShipment | undefined = res.data?.shipments?.[0];
      if (!shipment) return unavailable("No tracking detail from DHL yet");

      const statusCode = shipment.status?.statusCode; // pre-transit|transit|delivered|failure|unknown
      const statusText =
        shipment.status?.status ?? shipment.status?.description ?? null;

      if (statusCode === "delivered") {
        return {
          estimated_delivery: null,
          status: "delivered",
          detail: statusText,
        };
      }

      const estimated =
        shipment.estimatedTimeOfDelivery ??
        shipment.estimatedDeliveryTimeFrame?.estimatedThrough;

      return {
        estimated_delivery: toIsoDate(estimated),
        status: "in_transit",
        detail: statusText,
      };
    } catch (e: unknown) {
      const ax = e as { response?: { status?: number }; message?: string };
      if (ax.response?.status === 404) {
        return unavailable("DHL has no record yet (awaiting first scan)");
      }
      return errored(ax.message ?? "DHL lookup failed");
    }
  },
};
