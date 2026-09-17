import { voidVendorCredit } from "../void";
import { VendorCreditError } from "../types";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.trim().split("\n")[0]!.trim(), params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

const CREDIT = { id: "vcr_1", status: "posted", credit_date: "2026-09-01" };

describe("voidVendorCredit", () => {
  it("refuses when the credit has active applications", async () => {
    const client = fakeClient([
      { match: "status, credit_date FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_credit_application WHERE credit_id", rows: [{ id: "vcap_1" }] },
    ]);
    await expect(voidVendorCredit(client as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "has_active_applications",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("refuses when already voided", async () => {
    const client = fakeClient([
      { match: "status, credit_date FROM vendor_credit", rows: [{ ...CREDIT, status: "voided" }] },
    ]);
    await expect(voidVendorCredit(client as never, "vcr_1", "u1")).rejects.toThrow(VendorCreditError);
  });

  it("voids on the happy path (period open, no active applications)", async () => {
    const client = fakeClient([
      { match: "status, credit_date FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_credit_application WHERE credit_id", rows: [] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_credit SET status='voided'", rows: [] },
      { match: "UPDATE vendor_prepayment_consumption SET voided_at", rows: [] },
    ]);
    await voidVendorCredit(client as never, "vcr_1", "u1", "customer returned goods");
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("releases the check-line consumption of a prepayment credit inside the same transaction", async () => {
    const client = fakeClient([
      { match: "status, credit_date FROM vendor_credit", rows: [CREDIT] },
      { match: "FROM vendor_credit_application WHERE credit_id", rows: [] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_credit SET status='voided'", rows: [] },
      { match: "UPDATE vendor_prepayment_consumption SET voided_at", rows: [] },
    ]);
    await voidVendorCredit(client as never, "vcr_1", "u1");
    const release = client.calls.findIndex((c) => c.sql.includes("UPDATE vendor_prepayment_consumption"));
    const commit = client.calls.findIndex((c) => c.sql === "COMMIT");
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(commit);
    expect(client.calls[release]?.params).toEqual(["vcr_1"]);
  });

  it("converts a pg Date credit_date to an ISO string before the period-lock check", async () => {
    const client = fakeClient([
      { match: "status, credit_date FROM vendor_credit", rows: [{ ...CREDIT, credit_date: new Date(2026, 8, 11) }] },
      { match: "FROM vendor_credit_application WHERE credit_id", rows: [] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_credit SET status='voided'", rows: [] },
      { match: "UPDATE vendor_prepayment_consumption SET voided_at", rows: [] },
    ]);
    await voidVendorCredit(client as never, "vcr_1", "u1");
    const periodCheckCall = client.calls.find((c) => c.sql.includes("accounting_period_close"));
    expect(periodCheckCall?.params).toEqual(["2026-09-11"]);
  });
});
