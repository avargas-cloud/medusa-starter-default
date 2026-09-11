import { applyVendorCreditToBill } from "../apply";
import { VendorCreditError } from "../types";

/**
 * Fake pg client — routes each `.query()` to the first matching handler by
 * SQL substring, records the call sequence. Handlers are matched in the
 * order given so more specific patterns must come first.
 */
function fakeClient(
  handlers: Array<{ match: string; rows: unknown[] }>
) {
  const calls: string[] = [];
  return {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

const CREDIT = { id: "vcr_1", status: "posted", vendor_id: "qbv_1", total_cents: 10_000, applied_cents: 0 };
const BILL = { id: "vb_1", status: "confirmed", vendor_id: "qbv_1" };

describe("applyVendorCreditToBill", () => {
  it("refuses when the credit is not posted", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [{ ...CREDIT, status: "draft" }] },
    ]);
    await expect(
      applyVendorCreditToBill(client as never, {
        creditId: "vcr_1",
        vendorBillId: "vb_1",
        amountCents: 100,
        actorId: "u1",
      })
    ).rejects.toThrow(VendorCreditError);
    expect(client.calls).toEqual(["BEGIN", "SELECT id, status, vendor_id, total_cents, applied_cents FROM vendor_credit", "ROLLBACK"]);
  });

  it("refuses when the bill is not confirmed/synced", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_bill WHERE", rows: [{ ...BILL, status: "draft" }] },
    ]);
    await expect(
      applyVendorCreditToBill(client as never, {
        creditId: "vcr_1",
        vendorBillId: "vb_1",
        amountCents: 100,
        actorId: "u1",
      })
    ).rejects.toMatchObject({ code: "bill_not_payable" });
  });

  it("refuses a vendor mismatch", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_bill WHERE", rows: [{ ...BILL, vendor_id: "qbv_OTHER" }] },
    ]);
    await expect(
      applyVendorCreditToBill(client as never, {
        creditId: "vcr_1",
        vendorBillId: "vb_1",
        amountCents: 100,
        actorId: "u1",
      })
    ).rejects.toMatchObject({ code: "vendor_mismatch" });
  });

  it("refuses when the application would exceed the credit's total", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_bill WHERE", rows: [BILL] },
      { match: "SUM(amount_cents), 0)::bigint AS applied", rows: [{ applied: 9_500 }] },
    ]);
    await expect(
      applyVendorCreditToBill(client as never, {
        creditId: "vcr_1",
        vendorBillId: "vb_1",
        amountCents: 1_000, // 9500 + 1000 > 10000 total
        actorId: "u1",
      })
    ).rejects.toMatchObject({ code: "exceeds_credit_total" });
  });

  it("refuses when the application would exceed the bill's open balance", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_bill WHERE", rows: [BILL] },
      { match: "SUM(amount_cents), 0)::bigint AS applied", rows: [{ applied: 0 }] },
      // computeBillBalance's 3 queries, in order: payable, paid, credited
      { match: "FROM vendor_bill vb", rows: [{ id: "vb_1", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 500 }] },
      { match: "FROM vendor_bill_payment_allocation", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    await expect(
      applyVendorCreditToBill(client as never, {
        creditId: "vcr_1",
        vendorBillId: "vb_1",
        amountCents: 1_000, // bill balance is only 500
        actorId: "u1",
      })
    ).rejects.toMatchObject({ code: "exceeds_bill_balance" });
  });

  it("inserts the application and bumps applied_cents on the happy path", async () => {
    const client = fakeClient([
      { match: "total_cents, applied_cents FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_bill WHERE", rows: [BILL] },
      { match: "SUM(amount_cents), 0)::bigint AS applied", rows: [{ applied: 0 }] },
      { match: "FROM vendor_bill vb", rows: [{ id: "vb_1", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 5_000 }] },
      { match: "FROM vendor_bill_payment_allocation", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
      { match: "INSERT INTO vendor_credit_application", rows: [] },
      { match: "UPDATE vendor_credit SET applied_cents", rows: [] },
    ]);
    const result = await applyVendorCreditToBill(client as never, {
      creditId: "vcr_1",
      vendorBillId: "vb_1",
      amountCents: 1_000,
      actorId: "u1",
    });
    expect(result.id).toMatch(/^vcap/);
    expect(client.calls[0]).toBe("BEGIN");
    expect(client.calls.at(-1)).toBe("COMMIT");
  });
});
