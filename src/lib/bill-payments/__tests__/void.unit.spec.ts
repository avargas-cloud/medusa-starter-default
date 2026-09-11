import { voidBillPayment } from "../void";
import { BillPaymentError } from "../types";

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

const PAYMENT = { id: "vbp_1", status: "posted", payment_date: "2026-09-01" };

describe("voidBillPayment", () => {
  it("refuses a non-posted payment", async () => {
    const client = fakeClient([
      { match: "status, payment_date FROM vendor_bill_payment", rows: [{ ...PAYMENT, status: "voided" }] },
    ]);
    await expect(voidBillPayment(client as never, "vbp_1", "u1")).rejects.toThrow(BillPaymentError);
  });

  it("converts a pg Date payment_date to an ISO string before the period-lock check", async () => {
    const client = fakeClient([
      {
        match: "status, payment_date FROM vendor_bill_payment",
        rows: [{ ...PAYMENT, payment_date: new Date(2026, 8, 11) }],
      },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_bill_payment SET status='voided'", rows: [] },
    ]);
    await voidBillPayment(client as never, "vbp_1", "u1");
    const periodCheckCall = client.calls.find((c) => c.sql.includes("accounting_period_close"));
    expect(periodCheckCall?.params).toEqual(["2026-09-11"]);
  });

  it("voids on the happy path", async () => {
    const client = fakeClient([
      { match: "status, payment_date FROM vendor_bill_payment", rows: [PAYMENT] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "UPDATE vendor_bill_payment SET status='voided'", rows: [] },
    ]);
    await voidBillPayment(client as never, "vbp_1", "u1", "duplicate check");
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });
});
