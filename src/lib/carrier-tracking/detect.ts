/**
 * src/lib/carrier-tracking/detect.ts
 *
 * Carrier auto-detection from a tracking number. Mirrors the frontend
 * heuristics in store-pos/lib/tracking.ts so a tracking entry stored with
 * provider "Auto" can still be routed to the right carrier API server-side.
 */

export type DetectedProvider = "UPS" | "FedEx" | "USPS" | "DHL" | null;

/**
 * Resolve the carrier for a tracking number. Returns null when the format is
 * not recognized (caller should treat as unavailable for ETA purposes).
 */
export function detectProvider(trackingNumber: string): DetectedProvider {
  const t = trackingNumber.trim().toUpperCase();
  if (!t) return null;

  // UPS — 1Z + 16 chars
  if (t.startsWith("1Z") && t.length === 18) return "UPS";

  // USPS international/express (e.g. EA123456789US)
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t)) return "USPS";

  // Numeric strings
  if (/^\d{12,22}$/.test(t)) {
    // USPS Intelligent Mail: 20 or 22 digits starting with 9
    if (t.startsWith("9") && (t.length === 20 || t.length === 22))
      return "USPS";
    // Otherwise assume FedEx for 12-22 digit numbers
    return "FedEx";
  }

  // DHL Express — 10 numeric digits
  if (/^\d{10}$/.test(t)) return "DHL";

  return null;
}

/**
 * Given the provider stored on a tracking entry (which may be "Auto" or
 * "Other"), resolve the concrete carrier whose API should be queried.
 * Returns null when no API-backed carrier applies (Other / freight / unknown).
 */
export function resolveCarrier(
  provider: string,
  trackingNumber: string
): DetectedProvider {
  const p = provider.trim();
  if (p === "UPS" || p === "FedEx" || p === "USPS" || p === "DHL") {
    return p;
  }
  if (p === "Auto" || p === "") {
    return detectProvider(trackingNumber);
  }
  // "Other" or anything else → no carrier API.
  return null;
}
