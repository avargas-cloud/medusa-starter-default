/**
 * Unit tests for refreshPoTrackingEta — the Expected-Delivery write-back.
 *
 * Covers the robustness rules added on 2026-07-02:
 *  1. A transient carrier failure never wipes a previously known ETA.
 *  2. The carrier date always drives Expected Delivery when known — it
 *     overwrites any prior value (including a staff-entered date); a manual
 *     date is only a fallback while the carrier has no date.
 *  3. Once delivered, Expected Delivery reflects the ACTUAL delivery date, and
 *     a settled delivered entry is not re-queried.
 *
 * Updated 2026-07-30: tracking moved from the PO's `tracking` JSON column to
 * tables, and then the carrier numbers were split out of the shipment into
 * `purchase_order_tracking_number` (one delivery, several waybills). Rows are
 * therefore read and written through knex instead of the module service.
 *
 * The HEADER policy is unchanged across both moves, and these tests are the
 * proof of that — every expectation below is the same as before either one. The
 * service is now called ONLY to write `expected_at`; the last test asserts that
 * by name, so a stray write to the frozen JSON column would fail here.
 */

import type { CarrierTrackingResult } from "../../lib/carrier-tracking/types";
import type { RefreshableNumber } from "../../lib/carrier-tracking/refresh-po";

const mockFetch = jest.fn<Promise<CarrierTrackingResult>, [string, string]>();

jest.mock("../../lib/carrier-tracking/index", () => {
  const actual = jest.requireActual("../../lib/carrier-tracking/index");
  return {
    ...actual,
    fetchCarrierEta: (provider: string, tn: string) => mockFetch(provider, tn),
  };
});

// Imported AFTER the mock is registered so it binds to the mocked fetch.
import { refreshPoTrackingEta } from "../../lib/carrier-tracking/refresh-po";

const future = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function entry(over: Partial<RefreshableNumber> = {}): RefreshableNumber {
  return {
    id: "potrkn_1",
    purchase_order_id: "po_1",
    provider: "UPS",
    tracking_number: "1ZTEST",
    carrier_eta: null,
    manual_eta: null,
    carrier_status: "pending",
    carrier_detail: null,
    ...over,
  };
}

/**
 * Stands in for the knex connection: SELECTs return the fixture rows, every
 * other statement is recorded. Recording the SQL (not just the bindings) is
 * what lets the transient-error test assert that `carrier_eta` was never in
 * the UPDATE at all — asserting only on the returned value would pass even if
 * the row had been blanked on disk.
 */
function fakeDb(rows: RefreshableNumber[]) {
  const writes: Array<{ sql: string; bindings: unknown[] }> = [];
  return {
    writes,
    raw: async (sql: string, bindings: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) return { rows };
      writes.push({ sql, bindings });
      return { rows: [] };
    },
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
    const res = await refreshPoTrackingEta(fakeDb([entry()]), fakeService(), {
      id: "po_1",
      expected_at: null,
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
    const res = await refreshPoTrackingEta(
      fakeDb([entry({ carrier_eta: oldEta, carrier_status: "in_transit" })]),
      fakeService(),
      { id: "po_1", expected_at: new Date(`${oldEta}T00:00:00.000Z`) }
    );
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
    const res = await refreshPoTrackingEta(
      fakeDb([entry({ carrier_eta: null, carrier_status: "pending" })]),
      fakeService(),
      { id: "po_1", expected_at: new Date(`${manual}T00:00:00.000Z`) }
    );
    expect(res.expected_at?.slice(0, 10)).toBe(carrierEta);
  });

  it("keeps the manual date as a fallback when the carrier has no ETA", async () => {
    const manual = future(20);
    mockFetch.mockResolvedValue({
      estimated_delivery: null,
      status: "in_transit",
      detail: "In transit, no ETA yet",
    });
    const res = await refreshPoTrackingEta(
      fakeDb([entry({ carrier_eta: null, carrier_status: "pending" })]),
      fakeService(),
      { id: "po_1", expected_at: new Date(`${manual}T00:00:00.000Z`) }
    );
    expect(res.expected_at?.slice(0, 10)).toBe(manual);
  });

  it("uses a manual tracking ETA for Other without polling a carrier", async () => {
    const manualEta = future(11);
    const res = await refreshPoTrackingEta(
      fakeDb([
        entry({
          provider: "Other",
          tracking_number: "779292549",
          manual_eta: manualEta,
          carrier_status: "unavailable",
        }),
      ]),
      fakeService(),
      { id: "po_1", expected_at: null }
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.expected_at?.slice(0, 10)).toBe(manualEta);
    expect(res.tracking[0].manual_eta).toBe(manualEta);
  });

  it("prefers an automatic carrier ETA over the manual fallback", async () => {
    const manualEta = future(15);
    const carrierEta = future(7);
    mockFetch.mockResolvedValue({
      estimated_delivery: carrierEta,
      status: "in_transit",
      detail: "On the way",
    });
    const res = await refreshPoTrackingEta(
      fakeDb([entry({ manual_eta: manualEta })]),
      fakeService(),
      { id: "po_1", expected_at: null }
    );

    expect(res.expected_at?.slice(0, 10)).toBe(carrierEta);
  });

  it("uses the actual delivery date once delivered", async () => {
    const manual = future(5);
    const deliveredOn = future(-3); // 3 days ago
    mockFetch.mockResolvedValue({
      estimated_delivery: deliveredOn,
      status: "delivered",
      detail: "Delivered",
    });
    const res = await refreshPoTrackingEta(
      // Not yet settled (eta null) → re-fetched, comes back delivered.
      fakeDb([entry({ carrier_eta: null, carrier_status: "in_transit" })]),
      fakeService(),
      { id: "po_1", expected_at: new Date(`${manual}T00:00:00.000Z`) }
    );
    expect(res.expected_at?.slice(0, 10)).toBe(deliveredOn);
  });

  it("does not re-query a delivered entry that already has its date", async () => {
    const deliveredOn = future(-2);
    await refreshPoTrackingEta(
      fakeDb([entry({ carrier_eta: deliveredOn, carrier_status: "delivered" })]),
      fakeService(),
      { id: "po_1", expected_at: new Date(`${deliveredOn}T00:00:00.000Z`) }
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT wipe a known ETA on a transient error", async () => {
    const known = future(12);
    mockFetch.mockResolvedValue({
      estimated_delivery: null,
      status: "error",
      detail: "Request failed with status code 500",
    });
    const db = fakeDb([
      entry({ carrier_eta: known, carrier_status: "in_transit" }),
    ]);
    const res = await refreshPoTrackingEta(db, fakeService(), {
      id: "po_1",
      expected_at: new Date(`${known}T00:00:00.000Z`),
    });

    const saved = res.tracking[0];
    expect(saved.carrier_eta).toBe(known); // preserved
    expect(saved.carrier_status).toBe("in_transit"); // preserved
    expect(saved.carrier_detail).toBe("Request failed with status code 500");

    // And it was never blanked on disk either: the soft-null UPDATE touches
    // only the note and the fetch stamp.
    const trackingWrite = db.writes.find((w) => /UPDATE/i.test(w.sql));
    expect(trackingWrite).toBeDefined();
    expect(trackingWrite?.sql).not.toMatch(/carrier_eta\s*=/);
    expect(trackingWrite?.sql).not.toMatch(/carrier_status\s*=/);
  });

  it("writes expected_at through the service, not the tracking table", async () => {
    const eta = future(9);
    mockFetch.mockResolvedValue({
      estimated_delivery: eta,
      status: "in_transit",
      detail: null,
    });
    const svc = fakeService();
    await refreshPoTrackingEta(fakeDb([entry()]), svc, {
      id: "po_1",
      expected_at: null,
    });
    expect(svc.updates).toHaveLength(1);
    expect(svc.updates[0].id).toBe("po_1");
    // The header write carries ONLY expected_at — the JSON `tracking` column is
    // frozen and must never be written again.
    expect(Object.keys(svc.updates[0]).sort()).toEqual(["expected_at", "id"]);
  });
});
