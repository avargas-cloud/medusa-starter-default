import { voidVendorCreditApplication } from "../void-application";
import { VendorCreditError } from "../types";

/**
 * Fake pg client — routes each `.query()` to the first matching handler by
 * SQL substring, records the call sequence. Same shape as `apply.unit.spec.ts`.
 */
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

const APP = {
  id: "vcap_1",
  credit_id: "vcr_1",
  amount_cents: 1_000,
  voided_at: null,
  qb_applied_at: null,
};

describe("voidVendorCreditApplication", () => {
  it("voids normally when there is no QB trace and no posted payment reference", async () => {
    const client = fakeClient([
      { match: "credit_id, amount_cents, voided_at", rows: [APP] },
      { match: "FROM vendor_bill_payment_allocation vbpa", rows: [] },
      { match: "FROM qb_order_pipeline", rows: [] },
      { match: "UPDATE vendor_credit_application SET voided_at", rows: [] },
      { match: "UPDATE vendor_credit SET applied_cents", rows: [] },
    ]);
    await voidVendorCreditApplication(client as never, "vcap_1", "u1");
    expect(client.calls[0]).toBe("BEGIN");
    expect(client.calls.at(-1)).toBe("COMMIT");
  });

  it("refuses (409 applied_in_quickbooks) once qb_applied_at is stamped", async () => {
    const client = fakeClient([
      { match: "credit_id, amount_cents, voided_at", rows: [{ ...APP, qb_applied_at: "2026-09-15T12:00:00Z" }] },
      { match: "FROM vendor_bill_payment_allocation vbpa", rows: [] },
    ]);
    await expect(
      voidVendorCreditApplication(client as never, "vcap_1", "u1")
    ).rejects.toMatchObject({ code: "applied_in_quickbooks", status: 409 });
    expect(client.calls.at(-1)).toBe("ROLLBACK");
  });

  it("refuses (409 applying_in_quickbooks) while a vendor_credit_apply row is still in flight", async () => {
    const client = fakeClient([
      { match: "credit_id, amount_cents, voided_at", rows: [APP] },
      { match: "FROM vendor_bill_payment_allocation vbpa", rows: [] },
      { match: "FROM qb_order_pipeline", rows: [{ id: "row_1" }] },
    ]);
    await expect(
      voidVendorCreditApplication(client as never, "vcap_1", "u1")
    ).rejects.toMatchObject({ code: "applying_in_quickbooks", status: 409 });
  });

  it("a failed/skipped vendor_credit_apply row does NOT block the void", async () => {
    const client = fakeClient([
      { match: "credit_id, amount_cents, voided_at", rows: [APP] },
      { match: "FROM vendor_bill_payment_allocation vbpa", rows: [] },
      // The live-row query itself filters by status, so a failed row simply
      // never matches — represented here as an empty result.
      { match: "FROM qb_order_pipeline", rows: [] },
      { match: "UPDATE vendor_credit_application SET voided_at", rows: [] },
      { match: "UPDATE vendor_credit SET applied_cents", rows: [] },
    ]);
    await voidVendorCreditApplication(client as never, "vcap_1", "u1");
    expect(client.calls.at(-1)).toBe("COMMIT");
  });
});
