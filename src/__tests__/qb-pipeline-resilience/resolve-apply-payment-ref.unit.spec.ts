// Unit tests for resolveCanonicalApplyPaymentRef (Workstream A1).
// apply_payment rows must key by payment_application.id (papp_). The dual-keying
// bug: a caller without application_id fell back to payment_id (cpay_), creating
// a duplicate row alongside the route's papp_ row. This helper recovers the
// papp_ id via lookup when application_id is missing, and only falls back to the
// legacy customer_payment key when no application exists at all.

const query = jest.fn();
jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

import { resolveCanonicalApplyPaymentRef } from "../../lib/quickbooks/pipeline/row-mutations";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveCanonicalApplyPaymentRef", () => {
  it("uses application_id directly (papp_) without a DB lookup when present", async () => {
    const ref = await resolveCanonicalApplyPaymentRef({
      applicationId: "papp_123",
      paymentId: "cpay_999",
      invoiceId: "inv_1",
    });

    expect(ref).toEqual({
      referenceId: "papp_123",
      referenceType: "payment_application",
      resolvedFromLookup: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("recovers papp_ via lookup when application_id is missing", async () => {
    query.mockResolvedValue({ rows: [{ id: "papp_resolved" }] });

    const ref = await resolveCanonicalApplyPaymentRef({
      applicationId: null,
      paymentId: "cpay_999",
      invoiceId: "inv_1",
    });

    expect(ref).toEqual({
      referenceId: "papp_resolved",
      referenceType: "payment_application",
      resolvedFromLookup: true,
    });
    // lookup keyed on (payment_id, invoice_id), excluding voided
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/payment_id = \$1 AND invoice_id = \$2/);
    expect(String(sql)).toMatch(/voided_at IS NULL/);
    expect(params).toEqual(["cpay_999", "inv_1"]);
  });

  it("falls back to the legacy customer_payment key when no application exists", async () => {
    query.mockResolvedValue({ rows: [] });

    const ref = await resolveCanonicalApplyPaymentRef({
      applicationId: undefined,
      paymentId: "cpay_999",
      invoiceId: "inv_1",
    });

    expect(ref).toEqual({
      referenceId: "cpay_999",
      referenceType: "customer_payment",
      resolvedFromLookup: false,
    });
  });
});
