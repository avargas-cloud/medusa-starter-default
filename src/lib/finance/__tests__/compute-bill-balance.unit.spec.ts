import { computeBillBalance, computeBillBalancesBatch } from "../recompute-bill-finance";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  return {
    query: jest.fn(async (sql: string) => {
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

describe("computeBillBalance", () => {
  it("returns null for a bill that doesn't exist", async () => {
    const client = fakeClient([
      { match: "FROM vendor_bill vb", rows: [] },
      { match: "FROM vendor_bill_payment_allocation a", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    const result = await computeBillBalance(client as never, "vb_missing");
    expect(result).toBeNull();
  });

  it("sums non-deleted lines for a normal (non-adopted) bill", async () => {
    const client = fakeClient([
      {
        match: "FROM vendor_bill vb",
        rows: [{ id: "vb_1", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "2", line_total: 15_000 }],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [{ vendor_bill_id: "vb_1", paid: 5_000 }] },
      { match: "FROM vendor_credit_application ca", rows: [{ vendor_bill_id: "vb_1", credited: 1_000 }] },
    ]);
    const result = await computeBillBalance(client as never, "vb_1");
    expect(result).toEqual({
      vendor_bill_id: "vb_1",
      payable_cents: 15_000,
      paid_cents: 5_000,
      credited_cents: 1_000,
      balance_cents: 9_000,
      paid_status: "partial",
    });
  });

  it("falls back to qb_amount_due_cents for an adopted bill with zero lines (plan §1: 66 bills)", async () => {
    const client = fakeClient([
      {
        match: "FROM vendor_bill vb",
        rows: [{ id: "vb_adopted", status: "synced", qb_source: "adopted", qb_amount_due_cents: 42_00, line_count: "0", line_total: 0 }],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    const result = await computeBillBalance(client as never, "vb_adopted");
    expect(result?.payable_cents).toBe(4200);
    expect(result?.paid_status).toBe("open");
  });

  it("marks a fully paid bill as paid", async () => {
    const client = fakeClient([
      {
        match: "FROM vendor_bill vb",
        rows: [{ id: "vb_2", status: "synced", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 10_000 }],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [{ vendor_bill_id: "vb_2", paid: 10_000 }] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    const result = await computeBillBalance(client as never, "vb_2");
    expect(result?.balance_cents).toBe(0);
    expect(result?.paid_status).toBe("paid");
  });

  it("batches multiple bills in one call", async () => {
    const client = fakeClient([
      {
        match: "FROM vendor_bill vb",
        rows: [
          { id: "vb_a", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 1_000 },
          { id: "vb_b", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 2_000 },
        ],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    const result = await computeBillBalancesBatch(client as never, ["vb_a", "vb_b"]);
    expect(result.size).toBe(2);
    expect(result.get("vb_a")?.balance_cents).toBe(1_000);
    expect(result.get("vb_b")?.balance_cents).toBe(2_000);
  });

  it("returns an empty map for an empty id list without querying", async () => {
    const client = { query: jest.fn() };
    const result = await computeBillBalancesBatch(client as never, []);
    expect(result.size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});
