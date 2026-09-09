import type { PoolClient } from "pg";
import { assertOpeningClearMapping } from "../../lib/banking/opening-clear-mapping";

const bank = { account_id: "reconnected-feed-account", qb_list_id: "stable-bank-list-id", currency: "USD",
  type: "depository", is_active: true, is_selected: true, deleted: false, environment: "sandbox" };
const account = { id: bank.qb_list_id, name: "Renamed bank account", account_type: "Bank", currency: "US Dollar" };
function fixture(changes = {}, qb: Partial<typeof account> | null = {}, missing = false) {
  const query = jest.fn(async (sql: string, _args: unknown[]) => {
    if (sql.includes("FROM bank_transaction t")) return { rows: missing ? [] : [{ ...bank, ...changes }] };
    if (sql.includes("FROM qb_account")) return { rows: qb === null ? [] : [{ ...account, ...qb }] };
    throw new Error(`Unexpected query ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}
describe("historical clearing resolves the transaction's live bank mapping", () => {
  it("accepts a reconnected feed and renamed USD book account with the same ListID", async () => {
    const current = fixture();
    await expect(assertOpeningClearMapping(current.client, "new-feed-transaction", bank.qb_list_id)).resolves.toBeUndefined();
    expect(current.query.mock.calls[0]?.[1]).toEqual(["new-feed-transaction"]);
    expect(current.query.mock.calls[1]?.[1]).toEqual([[bank.qb_list_id]]);
  });
  it.each([
    { currency: "CAD" }, { currency: null }, { type: "credit" }, { is_active: false },
    { is_selected: false }, { deleted: true }, { environment: "production" }, { qb_list_id: "other-bank" },
  ])("rejects an ineligible effective feed mapping %j", async change => {
    await expect(assertOpeningClearMapping(fixture(change).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
  });
  it.each([{ currency: "CAD" }, { currency: "Dollar" }, { currency: "" }, { account_type: "Expense" }, { id: "other-bank" }])(
    "rejects incompatible live book mapping %j", async change => {
      await expect(assertOpeningClearMapping(fixture({}, change).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
    });
  it("rejects removed or inactive QB mappings absent from the active account lookup", async () => {
    await expect(assertOpeningClearMapping(fixture({}, null).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
    await expect(assertOpeningClearMapping(fixture({}, {}, true).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
  });
  it("accepts explicit ISO USD", async () => {
    await expect(assertOpeningClearMapping(fixture({}, { currency: "USD" }).client, "tx", bank.qb_list_id)).resolves.toBeUndefined();
  });
});
