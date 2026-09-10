import type { PoolClient } from "pg";
import { assertOpeningClearMapping } from "../../lib/banking/opening-clear-mapping";

const bank = { account_id: "reconnected-feed-account", qb_list_id: "stable-bank-list-id", currency: "USD",
  type: "depository", is_active: true, is_selected: true, deleted: false, environment: "sandbox" };
const account = { id: bank.qb_list_id, name: "Renamed bank account", account_type: "Bank", currency: "US Dollar" };
function fixture(changes = {}, qb: Partial<typeof account> | null = {}, missing = false, attested = true) {
  const query = jest.fn(async (sql: string, _args: unknown[]) => {
    if (sql.includes("FROM bank_transaction t")) return { rows: missing ? [] : [{ ...bank, ...changes }] };
    if (sql.includes("FROM qb_account")) return { rows: qb === null ? [] : [{ ...account, ...qb }] };
    if (sql.includes("FROM bank_accounting_setup")) return { rows: [{ id: "setup", revision: 1, cut_date: "2000-01-01", currency: "USD", attested, frozen: false }] };
    throw new Error(`Unexpected query ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}
const SANDBOX_ENV = { ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa" };
const savedEnv: Record<string, string | undefined> = {};
// The mapping check now compares the feed row against the served environment, so the spec must declare one.
beforeAll(() => { for (const [k, v] of Object.entries(SANDBOX_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(SANDBOX_ENV)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });
describe("historical clearing resolves the transaction's live bank mapping", () => {
  it("accepts a Bank account without a currency ref when the operator attested local USD, and not otherwise", async () => {
    await expect(assertOpeningClearMapping(fixture({}, { currency: null }, false, true).client, "tx", bank.qb_list_id)).resolves.toBeUndefined();
    await expect(assertOpeningClearMapping(fixture({}, { currency: null }, false, false).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
  });
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
  it("compares the feed row against the environment this process serves, never a literal 'sandbox'", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      ECOPOWERTECH_ENV: "production", DATABASE_URL: "postgresql://u:p@db.railway.internal:5432/railway",
      BANKING_ENABLED: "true", BANKING_ENV: "production", BANKING_EXPECTED_DB_TARGET: "db.railway.internal:5432/railway",
      PLAID_CLIENT_ID: "client", PLAID_PRODUCTION_SECRET: "secret", BANKING_WEBHOOK_URL: "https://api.example.invalid/pub/banking/webhook",
      BANKING_OAUTH_REDIRECT_URI: "https://pos.example.invalid/accounting/banks/oauth-return",
      BANKING_TOKEN_ACTIVE_KEY_ID: "production-v1", BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v1": "a".repeat(64) }),
    });
    try {
      await expect(assertOpeningClearMapping(fixture({ environment: "production" }).client, "tx", bank.qb_list_id)).resolves.toBeUndefined();
      await expect(assertOpeningClearMapping(fixture({ environment: "sandbox" }).client, "tx", bank.qb_list_id)).rejects.toThrow("BANKING_OPENING_MAPPING_STALE");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
  it("accepts explicit ISO USD", async () => {
    await expect(assertOpeningClearMapping(fixture({}, { currency: "USD" }).client, "tx", bank.qb_list_id)).resolves.toBeUndefined();
  });
});
