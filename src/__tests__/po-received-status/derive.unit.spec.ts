/**
 * Unit tests for the receipt-driven `po_status` derivation — stamps
 * "Fully Received" on full receipt and reconciles back down on a reversal.
 */

import {
  PO_STATUS_FULLY_RECEIVED,
  PO_STATUS_PARTIAL_RECEIVED,
  PO_STATUS_SHIPPED_WAITING,
  PO_STATUS_TO_ARRANGE_DELIVERY,
  poHasTracking,
  reconcileReceivedPoStatus,
  resolveReceivedPoStatus,
} from "../../lib/purchase-orders/po-received-status";

describe("resolveReceivedPoStatus", () => {
  it("fully received when received >= ordered (ordered > 0)", () => {
    expect(resolveReceivedPoStatus(10, 10, false)).toBe(PO_STATUS_FULLY_RECEIVED);
    expect(resolveReceivedPoStatus(10, 12, false)).toBe(PO_STATUS_FULLY_RECEIVED);
  });

  it("partial when some but not all received", () => {
    expect(resolveReceivedPoStatus(10, 4, true)).toBe(PO_STATUS_PARTIAL_RECEIVED);
  });

  it("zero received falls back to tracking-aware in-transit status", () => {
    expect(resolveReceivedPoStatus(10, 0, true)).toBe(PO_STATUS_SHIPPED_WAITING);
    expect(resolveReceivedPoStatus(10, 0, false)).toBe(
      PO_STATUS_TO_ARRANGE_DELIVERY
    );
  });

  it("empty PO (0 ordered) is never 'Fully Received'", () => {
    expect(resolveReceivedPoStatus(0, 0, false)).toBe(
      PO_STATUS_TO_ARRANGE_DELIVERY
    );
  });
});

describe("reconcileReceivedPoStatus", () => {
  it("stamps Fully Received on full receipt from any prior tag", () => {
    expect(
      reconcileReceivedPoStatus("US Customs Delay", "received", 10, 10, false)
    ).toBe(PO_STATUS_FULLY_RECEIVED);
  });

  it("stamps Partial on a partial receipt", () => {
    expect(
      reconcileReceivedPoStatus("PO Sent", "partially_received", 10, 3, false)
    ).toBe(PO_STATUS_PARTIAL_RECEIVED);
  });

  it("drops Fully Received → Partial when a line is added (ordered grows)", () => {
    expect(
      reconcileReceivedPoStatus(
        PO_STATUS_FULLY_RECEIVED,
        "partially_received",
        15,
        10,
        false
      )
    ).toBe(PO_STATUS_PARTIAL_RECEIVED);
  });

  it("drops Fully Received → tracking fallback when the last receipt is voided", () => {
    expect(
      reconcileReceivedPoStatus(
        PO_STATUS_FULLY_RECEIVED,
        "submitted",
        10,
        0,
        true
      )
    ).toBe(PO_STATUS_SHIPPED_WAITING);
    expect(
      reconcileReceivedPoStatus(
        PO_STATUS_FULLY_RECEIVED,
        "submitted",
        10,
        0,
        false
      )
    ).toBe(PO_STATUS_TO_ARRANGE_DELIVERY);
  });

  it("no-ops when the receipt-driven status is already correct", () => {
    expect(
      reconcileReceivedPoStatus(
        PO_STATUS_PARTIAL_RECEIVED,
        "partially_received",
        10,
        3,
        false
      )
    ).toBeNull();
  });

  it("never touches a manual/pre-arrival tag when nothing is received", () => {
    // Adding a line to a brand-new draft (0 received) must not clobber the tag.
    expect(
      reconcileReceivedPoStatus("PO Created", "draft", 5, 0, false)
    ).toBeNull();
    expect(reconcileReceivedPoStatus(null, "submitted", 5, 0, true)).toBeNull();
  });

  it("never touches a terminal (closed/cancelled/voided) PO", () => {
    expect(
      reconcileReceivedPoStatus(PO_STATUS_FULLY_RECEIVED, "closed", 10, 10, false)
    ).toBeNull();
    expect(
      reconcileReceivedPoStatus(
        PO_STATUS_PARTIAL_RECEIVED,
        "voided",
        10,
        3,
        false
      )
    ).toBeNull();
  });
});

describe("poHasTracking", () => {
  it("true only for a non-empty array", () => {
    expect(poHasTracking([{ id: "t1" }])).toBe(true);
    expect(poHasTracking([])).toBe(false);
    expect(poHasTracking(null)).toBe(false);
    expect(poHasTracking(undefined)).toBe(false);
  });
});
