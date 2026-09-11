import { createBillPayment } from "../create";
import { BillPaymentError } from "../types";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
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

const VENDOR = { id: "qbv_1", full_name: "Acme Co", qb_list_id: "80000001-123" };
const BANK_ACCOUNT = {
  qb_list_id: "80000002-456",
  full_name: "Operating Checking",
  account_type: "Bank",
  currency: "USD",
};
const BILL = { id: "vb_1", status: "confirmed", vendor_id: "qbv_1" };

const baseInput = {
  vendor_id: "qbv_1",
  bank_account_list_id: "80000002-456",
  payment_date: "2026-09-10",
  method: "check" as const,
  reference: "1042",
  memo: null,
  allocations: [{ vendor_bill_id: "vb_1", amount_cents: 1_000 }],
  actor_id: "u1",
};

describe("createBillPayment", () => {
  it("refuses when the bank account type doesn't match the method", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM qb_account", rows: [{ ...BANK_ACCOUNT, account_type: "CreditCard" }] },
    ]);
    await expect(createBillPayment(client as never, baseInput)).rejects.toMatchObject({
      code: "bank_account_type_mismatch",
    });
  });

  it("refuses when a bill is not confirmed/synced", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM qb_account", rows: [BANK_ACCOUNT] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "FROM vendor_bill\n", rows: [{ ...BILL, status: "draft" }] },
    ]);
    await expect(createBillPayment(client as never, baseInput)).rejects.toMatchObject({
      code: "bill_not_payable",
    });
  });

  it("refuses when an allocation exceeds the bill's open balance", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM qb_account", rows: [BANK_ACCOUNT] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "FROM vendor_bill\n", rows: [BILL] },
      {
        match: "FROM vendor_bill vb",
        rows: [{ id: "vb_1", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 500 }],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
    ]);
    await expect(createBillPayment(client as never, baseInput)).rejects.toMatchObject({
      code: "exceeds_bill_balance",
    });
  });

  it("refuses a Σallocations that would not equal a sane total (each allocation must be > 0)", async () => {
    const client = fakeClient([]);
    await expect(
      createBillPayment(client as never, {
        ...baseInput,
        allocations: [{ vendor_bill_id: "vb_1", amount_cents: 0 }],
      })
    ).rejects.toMatchObject({ code: "invalid_allocation_amount" });
  });

  it("posts on the happy path", async () => {
    const client = fakeClient([
      { match: "FROM qb_vendor WHERE", rows: [VENDOR] },
      { match: "FROM qb_account", rows: [BANK_ACCOUNT] },
      { match: "FROM accounting_period_close", rows: [] },
      { match: "FROM vendor_bill\n", rows: [BILL] },
      {
        match: "FROM vendor_bill vb",
        rows: [{ id: "vb_1", status: "confirmed", qb_source: "owned", qb_amount_due_cents: null, line_count: "1", line_total: 5_000 }],
      },
      { match: "FROM vendor_bill_payment_allocation a", rows: [] },
      { match: "FROM vendor_credit_application ca", rows: [] },
      { match: "'BP-' || nextval", rows: [{ number: "BP-1001" }] },
      { match: "INSERT INTO vendor_bill_payment", rows: [] },
      { match: "INSERT INTO vendor_bill_payment_allocation", rows: [] },
    ]);
    const result = await createBillPayment(client as never, baseInput);
    expect(result.number).toBe("BP-1001");
    expect(client.calls[0]).toBe("BEGIN");
    expect(client.calls.at(-1)).toBe("COMMIT");
  });
});
