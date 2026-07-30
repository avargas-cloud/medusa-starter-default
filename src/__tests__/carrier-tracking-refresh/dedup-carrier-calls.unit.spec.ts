/**
 * One carrier call per tracking number — never one per product, never one per
 * purchase order.
 *
 * ── Why this is a test and not a comment ─────────────────────────────────────
 * The fan-out from a number to the products it carries happens at READ time,
 * from data already fetched, so a PO with eight products on one waybill has
 * always been one lookup. That much is structural.
 *
 * What is NOT structural is the cross-PO case: the same waybill can name
 * deliveries on several purchase orders — a vendor consolidating orders onto
 * one truck, an LTL booking covering three POs. Refreshing PO by PO, which is
 * the obvious shape and the one this code used to have, asks the carrier about
 * that waybill once per PO. Nothing in the output would show it; the only
 * symptom is the carrier bill, and DHL's 250/day ceiling is close enough that
 * silently tripling the count matters.
 *
 * `stats.calls` is the honest count of external requests, and asserting on it
 * is the difference between "we deduplicate" and "we believe we deduplicate".
 */

import type { CarrierTrackingResult } from "../../lib/carrier-tracking/types";

const mockFetch = jest.fn<Promise<CarrierTrackingResult>, [string, string]>();

jest.mock("../../lib/carrier-tracking/index", () => {
  const actual = jest.requireActual("../../lib/carrier-tracking/index");
  return {
    ...actual,
    fetchCarrierEta: (provider: string, tn: string) => mockFetch(provider, tn),
  };
});

// Imported AFTER the mock is registered so it binds to the mocked fetch.
import {
  fetchUniqueEtas,
  lookupKey,
} from "../../lib/carrier-tracking/refresh-numbers";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    estimated_delivery: "2026-08-20",
    status: "in_transit",
    detail: null,
  });
});

describe("fetchUniqueEtas", () => {
  it("asks the carrier ONCE for a number that names deliveries on three POs", async () => {
    const shared = { provider: "UPS", tracking_number: "1ZSHARED" };
    const { stats, byKey } = await fetchUniqueEtas([shared, shared, shared]);

    expect(stats.rows).toBe(3);
    expect(stats.calls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Every row still gets an answer — dedup must not drop anyone.
    expect(byKey.get(lookupKey(shared))?.estimated_delivery).toBe("2026-08-20");
  });

  it("counts distinct numbers, not rows", async () => {
    const rows = [
      { provider: "UPS", tracking_number: "1ZA" },
      { provider: "UPS", tracking_number: "1ZB" },
      { provider: "UPS", tracking_number: "1ZA" },
      { provider: "FedEx", tracking_number: "770001" },
      { provider: "UPS", tracking_number: "1ZB" },
    ];
    const { stats } = await fetchUniqueEtas(rows);

    expect(stats.rows).toBe(5);
    expect(stats.calls).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("keys on provider AND number — same digits, different carrier, two calls", async () => {
    // Carriers reuse number shapes and "Auto" resolves per number, so two rows
    // with identical digits under different providers are genuinely different
    // lookups. Collapsing them would hand one carrier's answer to the other.
    const { stats } = await fetchUniqueEtas([
      { provider: "UPS", tracking_number: "123456789" },
      { provider: "FedEx", tracking_number: "123456789" },
    ]);

    expect(stats.calls).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there is nothing to poll", async () => {
    const { stats, byKey } = await fetchUniqueEtas([]);
    expect(stats).toEqual({ rows: 0, calls: 0 });
    expect(byKey.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
