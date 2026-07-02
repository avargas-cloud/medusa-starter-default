/**
 * Unit tests for reconcileShippedPoStatus — keeps a shipped PO's po_status
 * consistent with whether it still has a tracking number.
 */

import {
  PO_STATUS_SHIPPED_MISSING_TRACKING,
  PO_STATUS_SHIPPED_WAITING,
  reconcileShippedPoStatus,
} from "../../api/admin/purchase-orders/_lib/po-shipping-status";

describe("reconcileShippedPoStatus", () => {
  it("downgrades a shipped PO with no tracking to Missing Tracking", () => {
    expect(
      reconcileShippedPoStatus(PO_STATUS_SHIPPED_WAITING, "submitted", false)
    ).toBe(PO_STATUS_SHIPPED_MISSING_TRACKING);
  });

  it("upgrades Missing Tracking to Waiting once a number is on file", () => {
    expect(
      reconcileShippedPoStatus(
        PO_STATUS_SHIPPED_MISSING_TRACKING,
        "partially_received",
        true
      )
    ).toBe(PO_STATUS_SHIPPED_WAITING);
  });

  it("no-ops when the status is already correct", () => {
    expect(
      reconcileShippedPoStatus(PO_STATUS_SHIPPED_WAITING, "submitted", true)
    ).toBeNull();
  });

  it("never touches a non-shipped po_status", () => {
    expect(reconcileShippedPoStatus("PO Created", "submitted", false)).toBeNull();
    expect(reconcileShippedPoStatus(null, "submitted", false)).toBeNull();
  });

  it("never touches a PO whose lifecycle is terminal", () => {
    expect(
      reconcileShippedPoStatus(PO_STATUS_SHIPPED_WAITING, "received", false)
    ).toBeNull();
    expect(
      reconcileShippedPoStatus(PO_STATUS_SHIPPED_WAITING, "cancelled", false)
    ).toBeNull();
  });
});
