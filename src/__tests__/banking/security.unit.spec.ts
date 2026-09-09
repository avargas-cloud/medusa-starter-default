import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { bankAccess } from "../../lib/banking/auth";
import { getDbPool } from "../../api/utils/db-pool";
import {
  BankingError,
  bankingConfig,
  bankingErrorCode,
  decryptBankToken,
  encryptBankToken,
  requireBankingSandbox,
  sandboxTokenKey,
} from "../../lib/banking/security";

jest.mock("../../modules/pos-user", () => ({ POS_USER_MODULE: "pos_user" }));
jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));

const key = Buffer.alloc(32, 17);
const token = "fixture-token-for-unit-tests-only";
const connectionId = "bconn_unit_one";
const sandboxUrl = "postgresql://fixture:fixture@127.0.0.1:5499/medusa";
const envKeys = [
  "ECOPOWERTECH_ENV", "DATABASE_URL", "BANKING_ENABLED", "BANKING_SANDBOX_TOKEN_KEY",
  "BANKING_TOKEN_KEY", "BANKING_PRODUCTION_TOKEN_KEY", "JWT_SECRET", "COOKIE_SECRET",
  "PLAID_SECRET", "PLAID_PRODUCTION_SECRET", "PLAID_ENV",
] as const;
type SavedEnv = Partial<Record<(typeof envKeys)[number], string>>;
let savedEnv: SavedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const name of envKeys) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.ECOPOWERTECH_ENV = "sandbox";
  process.env.DATABASE_URL = sandboxUrl;
});

afterEach(() => {
  for (const name of envKeys) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

function expectBankingFailure(action: () => unknown, code: string, status = 503) {
  expect(action).toThrow(expect.objectContaining({ name: "Error", code, status }));
}

describe("bank token confidentiality and connection binding", () => {
  it("roundtrips a token while generating distinct IVs and ciphertexts for each encryption", () => {
    const first = encryptBankToken(token, connectionId, key);
    const second = encryptBankToken(token, connectionId, key);
    const a = JSON.parse(first) as Record<string, string | number>;
    const b = JSON.parse(second) as Record<string, string | number>;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(first).not.toContain(token);
    expect(decryptBankToken(first, connectionId, key)).toBe(token);
    expect(decryptBankToken(second, connectionId, key)).toBe(token);
  });

  it.each(["ciphertext", "iv", "tag"])("rejects a changed %s without revealing the token", (field) => {
    const envelope = JSON.parse(encryptBankToken(token, connectionId, key)) as Record<string, string>;
    const bytes = Buffer.from(envelope[field]!, "base64");
    bytes[0] = bytes[0]! ^ 1;
    envelope[field] = bytes.toString("base64");
    expectBankingFailure(
      () => decryptBankToken(JSON.stringify(envelope), connectionId, key),
      "BANKING_TOKEN_DECRYPTION_FAILED",
    );
  });

  it("rejects another connection and another encryption key", () => {
    const encrypted = encryptBankToken(token, connectionId, key);
    expectBankingFailure(() => decryptBankToken(encrypted, "bconn_other", key), "BANKING_TOKEN_DECRYPTION_FAILED");
    expectBankingFailure(() => decryptBankToken(encrypted, connectionId, Buffer.alloc(32, 18)), "BANKING_TOKEN_DECRYPTION_FAILED");
  });

  it.each([
    ["version", 2], ["key_id", "production-v1"], ["iv", ""], ["tag", ""],
  ])("rejects unsupported or malformed envelope %s", (field, value) => {
    const envelope = JSON.parse(encryptBankToken(token, connectionId, key)) as Record<string, unknown>;
    envelope[field] = value;
    expectBankingFailure(() => decryptBankToken(JSON.stringify(envelope), connectionId, key), "BANKING_TOKEN_DECRYPTION_FAILED");
  });

  it.each([token, JSON.stringify(token), "null", "{}"])("rejects plaintext or malformed token envelope %#", (encoded) => {
    expectBankingFailure(() => decryptBankToken(encoded, connectionId, key), "BANKING_TOKEN_DECRYPTION_FAILED");
  });

  it("refuses empty identity, empty token, and a key of the wrong size", () => {
    expectBankingFailure(() => encryptBankToken(token, "", key), "BANKING_ENCRYPTION_INVALID", 400);
    expectBankingFailure(() => encryptBankToken("", connectionId, key), "BANKING_ENCRYPTION_INVALID", 400);
    expectBankingFailure(() => encryptBankToken(token, connectionId, Buffer.alloc(16)), "BANKING_ENCRYPTION_INVALID", 400);
  });
});

describe("banking sandbox and dedicated credential gates", () => {
  it.each(["localhost", "127.0.0.1"])("accepts only the explicitly selected sandbox database at %s", (host) => {
    process.env.DATABASE_URL = `postgresql://fixture:fixture@${host}:5499/medusa`;
    expect(requireBankingSandbox).not.toThrow();
    process.env.BANKING_SANDBOX_TOKEN_KEY = key.toString("hex");
    expect(sandboxTokenKey()).toEqual(key);
  });

  it.each([undefined, "production", "preview", "Sandbox"])("rejects runtime %# even with BANKING_ENABLED=true", (runtime) => {
    if (runtime === undefined) delete process.env.ECOPOWERTECH_ENV;
    else process.env.ECOPOWERTECH_ENV = runtime;
    process.env.BANKING_ENABLED = "true";
    expect(bankingConfig().enabled).toBe(false);
    expectBankingFailure(requireBankingSandbox, "BANKING_SANDBOX_ONLY");
  });

  it.each([
    "postgresql://fixture:fixture@db.example.invalid:5499/medusa",
    "postgresql://fixture:fixture@localhost:5432/medusa",
    "postgresql://fixture:fixture@localhost:5499/production",
    "https://localhost:5499/medusa",
  ])("rejects database target %# even when the runtime says sandbox", (url) => {
    process.env.DATABASE_URL = url;
    expectBankingFailure(requireBankingSandbox, "BANKING_SANDBOX_DATABASE_REQUIRED");
  });

  it.each([undefined, "invalid-url"])("rejects an unconfigured or malformed database %#", (url) => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    expectBankingFailure(requireBankingSandbox, "BANKING_DATABASE_NOT_CONFIGURED");
  });

  it.each([undefined, "", "a".repeat(63), "z".repeat(64)])("rejects an absent or invalid dedicated key %#", (value) => {
    if (value === undefined) delete process.env.BANKING_SANDBOX_TOKEN_KEY;
    else process.env.BANKING_SANDBOX_TOKEN_KEY = value;
    expectBankingFailure(sandboxTokenKey, "BANKING_ENCRYPTION_KEY_REQUIRED");
  });

  it("never substitutes generic, production, JWT, cookie or Plaid secrets for the sandbox key", () => {
    for (const name of ["BANKING_TOKEN_KEY", "BANKING_PRODUCTION_TOKEN_KEY", "JWT_SECRET", "COOKIE_SECRET", "PLAID_SECRET", "PLAID_PRODUCTION_SECRET"]) {
      process.env[name] = key.toString("hex");
    }
    process.env.PLAID_ENV = "production";
    expect(bankingConfig().environment).toBe("sandbox");
    expectBankingFailure(sandboxTokenKey, "BANKING_ENCRYPTION_KEY_REQUIRED");
  });

  it("sanitizes unexpected errors rather than exposing external messages", () => {
    expect(bankingErrorCode(new Error(token))).toBe("BANKING_OPERATION_FAILED");
    expect(bankingErrorCode({ message: token })).toBe("BANKING_OPERATION_FAILED");
    expect(bankingErrorCode(new BankingError("BANKING_AUTH_REQUIRED", 401))).toBe("BANKING_AUTH_REQUIRED");
  });
});

/**
 * Fixture de identidad. REGLA NUEVA (2026-09-10): banking exige acceso a
 * Accounting — owner (`POS_OWNER_EMAILS`) o grant vivo en
 * `pos_accounting_grant`. La regla vieja que estos tests afirmaban —"ausente de
 * `pos_user` ⇒ full admin ⇒ puede todo"— ya no existe: un admin sin grant es
 * hoy un usuario cualquiera para banking.
 */
function requestFixture(
  options: {
    authenticated?: boolean;
    email?: string | null;
    staff?: boolean;
    accounting?: boolean;
  } = {}
) {
  const retrieveUser = jest.fn().mockResolvedValue({
    email: options.email === undefined ? "Accountant@Example.invalid" : options.email,
  });
  const query = jest.fn().mockResolvedValue({
    rows: [
      {
        in_pos_user: options.staff !== false,
        pos_is_admin: false,
        has_grant: options.accounting === true,
      },
    ],
  });
  jest.mocked(getDbPool).mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
  const resolve = jest.fn((name: string): unknown => {
    if (name === "user") return { retrieveUser };
    throw new Error(`Unexpected service: ${name}`);
  });
  const req = {
    auth_context: options.authenticated === false ? undefined : { actor_id: "usr_bank_unit" },
    scope: { resolve },
  } as unknown as AuthenticatedMedusaRequest;
  return { req, retrieveUser, query, resolve };
}

describe("bank access requires an accounting grant, not merely a Medusa admin", () => {
  it("rejects unauthenticated requests before accessing services", async () => {
    const { req, resolve } = requestFixture({ authenticated: false });
    await expect(bankAccess(req)).rejects.toMatchObject({ code: "BANKING_AUTH_REQUIRED", status: 401 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("un grant vivo SIN Admin habilita lectura pero no manejo", async () => {
    const { req, retrieveUser, query } = requestFixture({ accounting: true });
    await expect(bankAccess(req, false)).resolves.toEqual({ actorId: "usr_bank_unit", canManage: false });
    await expect(bankAccess(req, true)).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
    expect(retrieveUser).toHaveBeenCalledWith("usr_bank_unit");
    expect(query.mock.calls[0]?.[1]).toEqual(["usr_bank_unit", "accountant@example.invalid"]);
  });
  it.each([false, true])("Accounting + Admin (fuera de pos_user) habilita lectura Y manejo con manage=%s", async (manage) => {
    const { req } = requestFixture({ accounting: true, staff: false });
    await expect(bankAccess(req, manage)).resolves.toEqual({ actorId: "usr_bank_unit", canManage: true });
  });

  it.each([false, true])("denies ordinary staff with manage=%s", async (manage) => {
    const { req } = requestFixture();
    await expect(bankAccess(req, manage)).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
  });

  it.each([false, true])("REGLA NUEVA: un admin sin grant tampoco entra, manage=%s", async (manage) => {
    const { req } = requestFixture({ staff: false });
    await expect(bankAccess(req, manage)).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
  });

  it("el owner entra sin ninguna fila de grant", async () => {
    const saved = process.env.POS_OWNER_EMAILS;
    process.env.POS_OWNER_EMAILS = "accountant@example.invalid";
    try {
      const { req } = requestFixture({ staff: false });
      await expect(bankAccess(req, true)).resolves.toEqual({ actorId: "usr_bank_unit", canManage: true });
    } finally {
      if (saved === undefined) delete process.env.POS_OWNER_EMAILS;
      else process.env.POS_OWNER_EMAILS = saved;
    }
  });

  it.each([null, ""])("denies a user without a usable email %#", async (email) => {
    const { req, query } = requestFixture({ email, staff: false });
    await expect(bankAccess(req, true)).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
    expect(query).not.toHaveBeenCalled();
  });
});
