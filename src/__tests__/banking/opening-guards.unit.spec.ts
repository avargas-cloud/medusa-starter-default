import type { PoolClient } from "pg";
import { assertNoOpeningClear, openingClearProjection } from "../../lib/banking/opening-guards";
import { persistReview, type ReviewContext } from "../../lib/banking/review-core";
import { requireUnpostedBankAccount } from "../../lib/banking/review-setup";

function client(rows: object[]): PoolClient {
  return { query: jest.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as PoolClient;
}
describe("old opening clear remains a zero-GL exclusive claim", () => {
  it("blocks a new review mutation until explicit unclear, even without any journal", async () => {
    const db = client([{ id: "clear", item_id: "check" }]);
    await expect(persistReview(db, { tx: { id: "bank-tx" }, review: null } as ReviewContext,
      { status: "excluded" }, "actor", "exclude")).rejects.toThrow("BANKING_OPENING_TRANSACTION_CLAIMED");
    expect(jest.mocked(db.query)).toHaveBeenCalledTimes(1);
  });
  it("permits normal review validation after explicit unclear removes the active claim", async () => {
    await expect(assertNoOpeningClear(client([]), "bank-tx")).resolves.toBeUndefined();
    await expect(assertNoOpeningClear(client([{ id: "clear" }]), "bank-tx")).rejects.toThrow("BANKING_OPENING_TRANSACTION_CLAIMED");
  });
  it("adds claim context only to affected rows and preserves other legacy DTO objects", async () => {
    const normal = { id: "normal", review: { mode: "categorize" } }, cleared = { id: "cleared", amount: "1000" };
    const result = await openingClearProjection(client([{ id: "claim", transaction_id: "cleared", item_id: "check", reference: "CHECK-7" }]), [normal, cleared]);
    expect(result[0]).toBe(normal);
    expect(result[0]).not.toHaveProperty("opening_clear");
    expect(result[1]).toEqual({ ...cleared, opening_clear: { id: "claim", item_id: "check", reference: "CHECK-7" } });
  });
  it("freezes legacy account setup once a verified baseline exists without a journal", async () => {
    const db = { query: jest.fn(async (sql: string) => sql.includes("FROM bank_opening_balance b")
      ? { rows: [{ id: "baseline" }], rowCount: 1 } : { rows: [], rowCount: 0 }) } as unknown as PoolClient;
    await expect(requireUnpostedBankAccount(db, "bank")).rejects.toThrow("BANKING_ACCOUNTING_SETUP_FROZEN");
    await expect(requireUnpostedBankAccount(client([]), "bank")).resolves.toBeUndefined();
  });
});
