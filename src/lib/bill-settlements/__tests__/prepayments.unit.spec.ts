import { lockPrepaymentLine } from "../prepayments";
import { BillSettlementError } from "../types";

/**
 * Fake pg client — routes each `.query()` to the first matching handler by
 * SQL substring, same technique `vendor-credits/__tests__/apply.unit.spec.ts`
 * uses to avoid a full DB in a unit test.
 */
function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  return {
    query: jest.fn(async (sql: string) => {
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

const CHECK_LINE = {
  check_id: "chk_1",
  status: "posted",
  deleted_at: null,
  voided_at: null,
  payee_type: "vendor",
  payee_id: "qbv_1",
  amount_cents: 10_000,
  account_list_id: "80000152-1621454214",
};

describe("lockPrepaymentLine", () => {
  it("rejects a check line whose account is not OtherCurrentAsset", async () => {
    const client = fakeClient([
      { match: "FROM gl_check_line l", rows: [CHECK_LINE] },
      { match: "FROM qb_account WHERE", rows: [] },
    ]);
    await expect(lockPrepaymentLine(client as never, "gcl_1", "qbv_1")).rejects.toMatchObject({
      code: "prepayment_account_not_eligible",
    });
  });

  it("rejects a check line whose payee is a different vendor", async () => {
    const client = fakeClient([
      { match: "FROM gl_check_line l", rows: [{ ...CHECK_LINE, payee_id: "qbv_OTHER" }] },
    ]);
    await expect(lockPrepaymentLine(client as never, "gcl_1", "qbv_1")).rejects.toMatchObject({
      code: "prepayment_not_eligible",
    });
  });

  it("rejects a voided check", async () => {
    const client = fakeClient([
      { match: "FROM gl_check_line l", rows: [{ ...CHECK_LINE, voided_at: "2026-09-01T00:00:00Z" }] },
    ]);
    await expect(lockPrepaymentLine(client as never, "gcl_1", "qbv_1")).rejects.toThrow(BillSettlementError);
  });

  it("returns remaining = line amount minus live consumption", async () => {
    const client = fakeClient([
      { match: "FROM gl_check_line l", rows: [CHECK_LINE] },
      { match: "FROM qb_account WHERE", rows: [{ qb_list_id: CHECK_LINE.account_list_id, full_name: "VEETECH Co., Ltd" }] },
      { match: "FROM vendor_prepayment_consumption", rows: [{ consumed: "4000" }] },
    ]);
    const result = await lockPrepaymentLine(client as never, "gcl_1", "qbv_1");
    expect(result.remaining_cents).toBe(6_000);
    expect(result.account_name).toBe("VEETECH Co., Ltd");
  });
});
