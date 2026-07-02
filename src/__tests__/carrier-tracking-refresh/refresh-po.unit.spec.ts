/**
 * Unit tests for refreshPoTrackingEta — the Expected-Delivery write-back.
 *
 * Covers the two robustness rules added on 2026-07-02:
 *  1. A transient carrier failure never wipes a previously known ETA.
 *  2. The carrier ETA always drives Expected Delivery when known — it
 *     overwrites any prior value (including a staff-entered date); a manual
 *     date is only a fallback while the carrier has no ETA.
 */

import type {
  CarrierTrackingResult,
  TrackingEntry,
} from "../../lib/carrier-tracking/types";

const mockFetch = jest.fn<Promise<CarrierTrackingResult>, [string, string]>();

jest.mock("../../lib/carrier-tracking/index", () => {
  const actual = jest.requireActual("../../lib/carrier-tracking/index");
  return {
    ...actual,
    fetchCarrierEta: (provider: string, tn: string) => mockFetch(provider, tn),
  };
});

// Imported AFTER the mock is registered so it binds to the mocked fetch.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { refreshPoTrackingEta } from "../../lib/carrier-tracking/refresh-po";

const future = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function entry(over: Partial<TrackingEntry> = {}): TrackingEntry {
  return {
    id: "potrk_1",
    provider: "UPS",
    tracking_number: "1ZTEST",
    tracking_url: "",
    created_at: new Date().toISOString(),
    created_by_user_id: null,
    carrier_eta: null,
    carrier_status: "pending",
    carrier_eta_fetched_at: null,
    carrier_detail: null,
    ...over,
  };
}

function fakeService() {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    updatePurchaseOrders: async (d: Record<string, unknown>[]) => {
      updates.push(...d);
      return undefined;
    },
  };
}

beforeEach(() => mockFetch.mockReset());

describe("refreshPoTrackingEta", () => {
  it("fills Expected Delivery when it is empty", async () => {
    const eta = future(10);
    mockFetch.mockResolvedValue({
      estimated_delivery: eta,
      status: "in_transit",
      detail: "On the way",
    });
    const svc = fakeService();
    const res = await refreshPoTrackingEta(svc, {
      id: "po_1",
      expected_at: null,
      tracking: [entry()],
    });
    expect(res.expected_at?.slice(0, 10)).toBe(eta);
    expect(res.changed).toBe(true);
  });

  it("keeps Expected Delivery in sync when the carrier ETA changes", async () => {
    const oldEta = future(10);
    const newEta = future(15);
    mockFetch.mockResolvedValue({
      estimated_delivery: newEta,
      status: "in_transit",
      detail: null,
    });
    const svc = fakeService();
    const res = await refreshPoTrackingEta(svc, {
      id: "po_1",
      expected_at: new Date(`${oldEta}T00:00:00.000Z`),
      tracking: [entry({ carrier_eta: oldEta, carrier_status: "in_transit" })],
    });
    expect(res.expected_at?.slice(0, 10)).toBe(newEta);
  });

  it("carrier ETA overwrites a staff-entered date (carrier always wins)", async () => {
    const manual = future(20);
    const carrierEta = future(8);
    mockFetch.mockResolvedValue({
      estimated_delivery: carrierEta,
      status: "in_transit",
      detail: null,
    });
    const svc = fakeService();
    const res = await refreshPoTrackingEta(svc, {
      id: "po_1",
      expected_at: new Date(`${manual}T00:00:00.000Z`),
      tracking: [entry({ carrier_eta: null, carrier_status: "pending" })],
    });
    expect(res.expected_at?.slice(0, 10)).toBe(carrierEta);
  });

  it("keeps the manual date as a fallback when the carrier has no ETA", async () => {
    const manual = future(20);
    mockFetch.mockResolvedValue({
      estimated_delivery: null,
      status: "in_transit",
      detail: "In transit, no ETA yet",
    });
    const svc = fakeService();
    const res = await refreshPoTrackingEta(svc, {
      id: "po_1",
      expected_at: new Date(`${manual}T00:00:00.000Z`),
      tracking: [entry({ carrier_eta: null, carrier_status: "pending" })],
    });
    expect(res.expected_at?.slice(0, 10)).toBe(manual);
  });

  it("does NOT wipe a known ETA on a transient error", async () => {
    const known = future(12);
    mockFetch.mockResolvedValue({
      estimated_delivery: null,
      status: "error",
      detail: "Request failed with status code 500",
    });
    const svc = fakeService();
    await refreshPoTrackingEta(svc, {
      id: "po_1",
      expected_at: new Date(`${known}T00:00:00.000Z`),
      tracking: [
        entry({ carrier_eta: known, carrier_status: "in_transit" }),
      ],
    });
    const saved = (svc.updates[0].tracking as TrackingEntry[])[0];
    expect(saved.carrier_eta).toBe(known); // preserved
    expect(saved.carrier_status).toBe("in_transit"); // preserved
    expect(saved.carrier_detail).toBe("Request failed with status code 500");
  });
});
