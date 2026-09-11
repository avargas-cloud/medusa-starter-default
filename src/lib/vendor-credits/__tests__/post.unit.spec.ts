import { markVendorCreditPosted } from "../post";
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

describe("markVendorCreditPosted", () => {
  it("refuses a draft with zero lines (no_lines)", async () => {
    const client = fakeClient([
      {
        match: "status, credit_date, total_cents FROM vendor_credit",
        rows: [{ id: "vcr_1", status: "draft", credit_date: new Date(2026, 8, 11), total_cents: 0 }],
      },
      { match: "FROM vendor_credit_line WHERE credit_id", rows: [{ n: 0 }] },
    ]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toMatchObject({
      code: "no_lines",
    });
  });

  it("converts a pg Date credit_date to an ISO string before the period-lock check", async () => {
    const client = fakeClient([
      {
        match: "status, credit_date, total_cents FROM vendor_credit",
        rows: [{ id: "vcr_1", status: "draft", credit_date: new Date(2026, 8, 11), total_cents: 5_000 }],
      },
      { match: "FROM vendor_credit_line WHERE credit_id", rows: [{ n: 1 }] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "'VC-' || nextval", rows: [{ number: "VC-1001" }] },
      { match: "UPDATE vendor_credit SET status='posted'", rows: [] },
    ]);
    const result = await markVendorCreditPosted(client as never, "vcr_1", "u1");
    expect(result.number).toBe("VC-1001");

    const periodCheckCall = client.calls.find((c) => c.sql.includes("accounting_period_close"));
    expect(periodCheckCall?.params).toEqual(["2026-09-11"]);
  });

  it("refuses a non-draft credit", async () => {
    const client = fakeClient([
      {
        match: "status, credit_date, total_cents FROM vendor_credit",
        rows: [{ id: "vcr_1", status: "posted", credit_date: new Date(2026, 8, 11), total_cents: 5_000 }],
      },
    ]);
    await expect(markVendorCreditPosted(client as never, "vcr_1", "u1")).rejects.toThrow(VendorCreditError);
  });
});
