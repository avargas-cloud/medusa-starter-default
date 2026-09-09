import { randomBytes } from "node:crypto";
import { bankingConfig, bankingEnvSql, bankingTokenKey, decryptBankToken, encryptBankToken, envelopeKeyId,
  requireBankingEnabled, requireBankingSandbox, BankingError } from "../../lib/banking/security";
import { bankingLimits, limitCode } from "../../lib/banking/limits";
import { assertBankingControl, readBankingControl } from "../../lib/banking/control";

const VARS = ["ECOPOWERTECH_ENV", "DATABASE_URL", "BANKING_ENABLED", "BANKING_ENV", "BANKING_EXPECTED_DB_TARGET",
  "PLAID_CLIENT_ID", "PLAID_PRODUCTION_SECRET", "PLAID_SANDBOX_SECRET", "BANKING_WEBHOOK_URL", "BANKING_OAUTH_REDIRECT_URI",
  "BANKING_TOKEN_ACTIVE_KEY_ID", "BANKING_TOKEN_KEYS_JSON", "BANKING_SANDBOX_TOKEN_KEY", "BANKING_MAX_ACTIVE_CONNECTIONS"];
const saved: Record<string, string | undefined> = {};
const k1 = randomBytes(32).toString("hex"), k2 = randomBytes(32).toString("hex");

function production(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ECOPOWERTECH_ENV: "production", DATABASE_URL: "postgresql://u:p@db.railway.internal:5432/railway",
    BANKING_ENABLED: "true", BANKING_ENV: "production", BANKING_EXPECTED_DB_TARGET: "db.railway.internal:5432/railway",
    PLAID_CLIENT_ID: "client", PLAID_PRODUCTION_SECRET: "secret", BANKING_WEBHOOK_URL: "https://api.example.invalid/pub/banking/webhook",
    BANKING_OAUTH_REDIRECT_URI: "https://pos.example.invalid/accounting/banks/oauth-return",
    BANKING_TOKEN_ACTIVE_KEY_ID: "production-v1", BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v1": k1 }),
  };
  for (const name of VARS) delete process.env[name];
  for (const [name, value] of Object.entries({ ...base, ...overrides })) { if (value !== undefined) process.env[name] = value; }
}
function failure(call: () => unknown, code: string) {
  try { call(); } catch (error) { expect(error).toBeInstanceOf(BankingError); expect((error as BankingError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
}

beforeEach(() => { for (const name of VARS) saved[name] = process.env[name]; });
afterEach(() => { for (const name of VARS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

describe("production is selected only by complete explicit configuration", () => {
  it("enables production when every variable is present and consistent", () => {
    production();
    expect(bankingConfig()).toEqual({ enabled: true, environment: "production", unavailable_reason: null, config_error: null });
    expect(requireBankingEnabled()).toBe("production");
    expect(bankingEnvSql()).toBe("'production'");
    failure(requireBankingSandbox, "BANKING_SANDBOX_ONLY");
  });

  it.each([
    ["BANKING_ENV", undefined, "BANKING_SANDBOX_ONLY", null],
    ["BANKING_ENABLED", "false", "BANKING_SANDBOX_ONLY", null],
    ["BANKING_EXPECTED_DB_TARGET", undefined, "BANKING_CONFIG_ERROR", "BANKING_DATABASE_TARGET_REQUIRED"],
    ["DATABASE_URL", "postgresql://u:p@other.host:5432/railway", "BANKING_CONFIG_ERROR", "BANKING_DATABASE_TARGET_MISMATCH"],
    ["DATABASE_URL", undefined, "BANKING_CONFIG_ERROR", "BANKING_DATABASE_NOT_CONFIGURED"],
    ["PLAID_PRODUCTION_SECRET", undefined, "BANKING_CONFIG_ERROR", "BANKING_PLAID_NOT_CONFIGURED"],
    ["BANKING_WEBHOOK_URL", "http://insecure.example.invalid/hook", "BANKING_CONFIG_ERROR", "BANKING_INVALID_WEBHOOK_URL"],
    ["BANKING_OAUTH_REDIRECT_URI", undefined, "BANKING_CONFIG_ERROR", "BANKING_INVALID_REDIRECT_URI"],
    ["BANKING_TOKEN_KEYS_JSON", JSON.stringify({ "production-v2": k1 }), "BANKING_CONFIG_ERROR", "BANKING_ENCRYPTION_KEYRING_INVALID"],
    ["BANKING_TOKEN_KEYS_JSON", JSON.stringify({ "production-v1": "zz".repeat(32) }), "BANKING_CONFIG_ERROR", "BANKING_ENCRYPTION_KEYRING_INVALID"],
    ["BANKING_MAX_ACTIVE_CONNECTIONS", "0", "BANKING_CONFIG_ERROR", "BANKING_LIMITS_INVALID"],
  ])("fails closed when %s is %s", (name, value, reason, configError) => {
    production({ [name]: value });
    const config = bankingConfig();
    expect(config.enabled).toBe(false);
    expect(config.unavailable_reason).toBe(reason);
    expect(config.config_error).toBe(configError);
    failure(requireBankingEnabled, reason);
  });

  it("refuses the sandbox database even when it is the declared target", () => {
    production({ DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa", BANKING_EXPECTED_DB_TARGET: "localhost:5499/medusa" });
    expect(bankingConfig().config_error).toBe("BANKING_DATABASE_TARGET_MISMATCH");
  });

  it("never lets the sandbox runtime become production, whatever else is set", () => {
    production({ ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa", BANKING_SANDBOX_TOKEN_KEY: k1 });
    expect(bankingConfig()).toEqual({ enabled: true, environment: "sandbox", unavailable_reason: null, config_error: null });
    expect(bankingEnvSql()).toBe("'sandbox'");
    expect(bankingTokenKey().active.id).toBe("sandbox-v1");
  });
});

describe("token key ring", () => {
  it("encrypts with the active key and decrypts only through the envelope key id", () => {
    production({ BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v1": k1, "production-v2": k2 }) });
    const ring = bankingTokenKey();
    const encoded = encryptBankToken("access-production-abc", "bconn_1", ring);
    expect(JSON.parse(encoded)).toMatchObject({ version: 2, key_id: "production-v1" });
    expect(envelopeKeyId(encoded)).toBe("production-v1");
    expect(decryptBankToken(encoded, "bconn_1", ring)).toBe("access-production-abc");
    failure(() => decryptBankToken(encoded, "bconn_2", ring), "BANKING_TOKEN_DECRYPTION_FAILED");
    // Rotation: the old key stays readable by id after the active one changes.
    production({ BANKING_TOKEN_ACTIVE_KEY_ID: "production-v2", BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v1": k1, "production-v2": k2 }) });
    const rotated = bankingTokenKey();
    expect(decryptBankToken(encoded, "bconn_1", rotated)).toBe("access-production-abc");
    expect(JSON.parse(encryptBankToken("x", "bconn_1", rotated)).key_id).toBe("production-v2");
    // Removing the old id from the ring makes its ciphertexts unreadable — no other key is ever tried.
    production({ BANKING_TOKEN_ACTIVE_KEY_ID: "production-v2", BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v2": k2 }) });
    failure(() => decryptBankToken(encoded, "bconn_1", bankingTokenKey()), "BANKING_TOKEN_DECRYPTION_FAILED");
  });

  it("keeps sandbox envelopes byte-compatible and refuses cross-environment envelopes", () => {
    production({ ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa", BANKING_SANDBOX_TOKEN_KEY: k1 });
    const sandboxRing = bankingTokenKey();
    const v1 = encryptBankToken("access-sandbox-abc", "bconn_s", sandboxRing);
    expect(JSON.parse(v1)).toMatchObject({ version: 1, key_id: "sandbox-v1" });
    expect(decryptBankToken(v1, "bconn_s", Buffer.from(k1, "hex"))).toBe("access-sandbox-abc");
    production({ BANKING_TOKEN_KEYS_JSON: JSON.stringify({ "production-v1": k1 }) });
    failure(() => decryptBankToken(v1, "bconn_s", bankingTokenKey()), "BANKING_TOKEN_DECRYPTION_FAILED");
  });
});

describe("limits and error codes per environment", () => {
  it("keeps the historical sandbox caps and names", () => {
    production({ ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa" });
    expect(bankingLimits()).toEqual({ connections: 3, accounts: 10, transactions: 2000, syncRuns: 100, webhookEvents: 2000, batch: 10000 });
    expect(limitCode("CONNECTION")).toBe("BANKING_SANDBOX_CONNECTION_LIMIT");
  });
  it("drops cumulative ceilings in production and keeps the connection quota", () => {
    production({ BANKING_MAX_ACTIVE_CONNECTIONS: "12" });
    expect(bankingLimits()).toEqual({ connections: 12, accounts: 120, transactions: null, syncRuns: null, webhookEvents: null, batch: 10000 });
    expect(limitCode("CONNECTION")).toBe("BANKING_CONNECTION_LIMIT");
  });
});

describe("persistent kill switch", () => {
  const client = (rows: { regclass: string | null; control?: { enabled: boolean } }) => ({
    query: jest.fn(async (sql: string) => sql.includes("to_regclass")
      ? { rows: [{ name: rows.regclass }] }
      : { rows: rows.control ? [{ ...rows.control, reason: null, updated_by: null, updated_at: null }] : [] }),
  }) as unknown as Parameters<typeof readBankingControl>[0];

  it("treats a missing table as enabled in sandbox and as a hard failure in production", async () => {
    production({ ECOPOWERTECH_ENV: "sandbox", DATABASE_URL: "postgresql://postgres:sandbox@localhost:5499/medusa" });
    await expect(readBankingControl(client({ regclass: null }))).resolves.toMatchObject({ enabled: true });
    production();
    await expect(readBankingControl(client({ regclass: null }))).rejects.toMatchObject({ code: "BANKING_CONTROL_MISSING" });
  });
  it("pauses every guarded operation when the row is disabled", async () => {
    production();
    await expect(assertBankingControl(client({ regclass: "bank_control", control: { enabled: false } }))).rejects.toMatchObject({ code: "BANKING_PAUSED" });
    await expect(assertBankingControl(client({ regclass: "bank_control", control: { enabled: true } }))).resolves.toBeUndefined();
  });
});
