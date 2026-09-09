import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class BankingError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export type BankingEnvironment = "sandbox" | "production";
export type BankingKey = { id: string; key: Buffer };
/** Encrypt with `active`; decrypt ONLY with the key named by the envelope. Never try the others. */
export type BankingKeyRing = { environment: BankingEnvironment; active: BankingKey; byId(id: string): BankingKey | undefined };

const SANDBOX_TARGET = { hosts: ["localhost", "127.0.0.1"], port: "5499", pathname: "/medusa" };
const HEX_KEY = /^[a-f0-9]{64}$/i;
const PRODUCTION_KEY_ID = /^production-v[1-9][0-9]{0,3}$/;

function parseTarget(url: string | undefined) {
  try {
    const target = new URL(url || "");
    return { protocol: target.protocol, host: target.hostname, port: target.port, pathname: target.pathname };
  } catch { return null; }
}
function isSandboxTarget(target: { protocol: string; host: string; port: string; pathname: string }) {
  return ["postgres:", "postgresql:"].includes(target.protocol) && SANDBOX_TARGET.hosts.includes(target.host)
    && target.port === SANDBOX_TARGET.port && target.pathname === SANDBOX_TARGET.pathname;
}
function httpsUrlError(value: string | undefined, code: string): string | null {
  if (!value) return code;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? null : code;
  } catch { return code; }
}

/** Production is selected ONLY by explicit, complete configuration; any gap keeps Banking off (fail closed). */
function productionConfigError(): string | null {
  const expected = process.env.BANKING_EXPECTED_DB_TARGET || "";
  const match = /^([^:/\s]+):(\d{2,5})(\/[A-Za-z0-9_-]+)$/.exec(expected);
  if (!match) return "BANKING_DATABASE_TARGET_REQUIRED";
  const actual = parseTarget(process.env.DATABASE_URL);
  if (!actual || !["postgres:", "postgresql:"].includes(actual.protocol)) return "BANKING_DATABASE_NOT_CONFIGURED";
  if (actual.host !== match[1] || actual.port !== match[2] || actual.pathname !== match[3]) return "BANKING_DATABASE_TARGET_MISMATCH";
  if (isSandboxTarget(actual)) return "BANKING_DATABASE_TARGET_MISMATCH";
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_PRODUCTION_SECRET) return "BANKING_PLAID_NOT_CONFIGURED";
  const webhook = httpsUrlError(process.env.BANKING_WEBHOOK_URL, "BANKING_INVALID_WEBHOOK_URL");
  if (webhook) return webhook;
  const redirect = httpsUrlError(process.env.BANKING_OAUTH_REDIRECT_URI, "BANKING_INVALID_REDIRECT_URI");
  if (redirect) return redirect;
  if (!productionKeyRing()) return "BANKING_ENCRYPTION_KEYRING_INVALID";
  const limit = process.env.BANKING_MAX_ACTIVE_CONNECTIONS;
  if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) return "BANKING_LIMITS_INVALID";
  return null;
}

function productionKeyRing(): BankingKeyRing | null {
  const activeId = process.env.BANKING_TOKEN_ACTIVE_KEY_ID || "";
  if (!PRODUCTION_KEY_ID.test(activeId)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(process.env.BANKING_TOKEN_KEYS_JSON || ""); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = new Map<string, BankingKey>();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PRODUCTION_KEY_ID.test(id) || typeof value !== "string" || !HEX_KEY.test(value)) return null;
    keys.set(id, { id, key: Buffer.from(value, "hex") });
  }
  const active = keys.get(activeId);
  if (!active || keys.size > 8) return null;
  return { environment: "production", active, byId: (id) => keys.get(id) };
}

/** The sandbox runtime keeps its exact historical behavior; production needs every variable of productionConfigError(). */
export function bankingConfig(): { enabled: boolean; environment: BankingEnvironment; unavailable_reason: string | null; config_error: string | null } {
  if (process.env.ECOPOWERTECH_ENV === "sandbox") {
    return { enabled: true, environment: "sandbox", unavailable_reason: null, config_error: null };
  }
  const requested = process.env.BANKING_ENABLED === "true" && process.env.BANKING_ENV === "production";
  if (!requested) return { enabled: false, environment: "sandbox", unavailable_reason: "BANKING_SANDBOX_ONLY", config_error: null };
  const error = productionConfigError();
  if (error) return { enabled: false, environment: "production", unavailable_reason: "BANKING_CONFIG_ERROR", config_error: error };
  return { enabled: true, environment: "production", unavailable_reason: null, config_error: null };
}

/** Strict sandbox gate: fixtures, bootstrap, adversarial probes and the sandbox runtime keep using this one. */
export function requireBankingSandbox() {
  if (bankingConfig().environment !== "sandbox" || !bankingConfig().enabled) throw new BankingError("BANKING_SANDBOX_ONLY", 503);
  const target = parseTarget(process.env.DATABASE_URL);
  if (!target) throw new BankingError("BANKING_DATABASE_NOT_CONFIGURED", 503);
  if (!isSandboxTarget(target)) throw new BankingError("BANKING_SANDBOX_DATABASE_REQUIRED", 503);
}

/** Operational gate: sandbox behaves exactly as requireBankingSandbox; production re-checks its declared database target. */
export function requireBankingEnabled(): BankingEnvironment {
  const config = bankingConfig();
  if (!config.enabled) throw new BankingError(config.unavailable_reason ?? "BANKING_SANDBOX_ONLY", 503);
  if (config.environment === "sandbox") { requireBankingSandbox(); return "sandbox"; }
  const error = productionConfigError();
  if (error) throw new BankingError(error, 503);
  return "production";
}

/** Operator decision 2026-09-09: the paid /transactions/refresh ($0.12/call) is OFF in production — the team
 *  reconciles yesterday every morning from Plaid's free automatic updates. Sandbox keeps it (suites exercise it). */
export function manualRefreshAllowed(): boolean {
  return bankingConfig().environment !== "production" || process.env.BANKING_MANUAL_REFRESH === "true";
}

/** Quoted SQL literal of the ACTIVE environment; the only accepted way to filter bank_* rows by environment. */
export function bankingEnvSql(): "'sandbox'" | "'production'" {
  return bankingConfig().environment === "production" ? "'production'" : "'sandbox'";
}

/** Dedicated random 256-bit key; never derive from Plaid, JWT or cookie secrets. */
export function sandboxTokenKey(): Buffer {
  requireBankingSandbox();
  const value = process.env.BANKING_SANDBOX_TOKEN_KEY || "";
  if (!HEX_KEY.test(value)) throw new BankingError("BANKING_ENCRYPTION_KEY_REQUIRED", 503);
  return Buffer.from(value, "hex");
}

export function bankingTokenKey(): BankingKeyRing {
  if (requireBankingEnabled() === "sandbox") {
    const active = { id: "sandbox-v1", key: sandboxTokenKey() };
    return { environment: "sandbox", active, byId: (id) => (id === active.id ? active : undefined) };
  }
  const ring = productionKeyRing();
  if (!ring) throw new BankingError("BANKING_ENCRYPTION_KEYRING_INVALID", 503);
  return ring;
}

type EnvelopeV1 = { version: 1; key_id: "sandbox-v1"; iv: string; tag: string; ciphertext: string };
type EnvelopeV2 = { version: 2; key_id: string; iv: string; tag: string; ciphertext: string };
type Envelope = EnvelopeV1 | EnvelopeV2;

/** A bare Buffer is the legacy sandbox key; sandbox envelopes stay byte-compatible (version 1, fixed AAD). */
function ringOf(material: BankingKeyRing | Buffer): BankingKeyRing {
  if (Buffer.isBuffer(material)) {
    const active = { id: "sandbox-v1", key: material };
    return { environment: "sandbox", active, byId: (id) => (id === active.id ? active : undefined) };
  }
  return material;
}
function aadFor(environment: BankingEnvironment, connectionId: string, keyId: string): Buffer {
  return Buffer.from(environment === "sandbox" ? `banking:sandbox:${connectionId}:v1` : `banking:production:${connectionId}:${keyId}`);
}

/** Bind each ciphertext to its environment, stable connection identity and key id. */
export function encryptBankToken(token: string, connectionId: string, material: BankingKeyRing | Buffer): string {
  const ring = ringOf(material);
  if (ring.active.key.length !== 32 || !token || !connectionId) throw new BankingError("BANKING_ENCRYPTION_INVALID");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.active.key, iv);
  cipher.setAAD(aadFor(ring.environment, connectionId, ring.active.id));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const envelope: Envelope = ring.environment === "sandbox"
    ? { version: 1, key_id: "sandbox-v1", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }
    : { version: 2, key_id: ring.active.id, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  return JSON.stringify(envelope);
}

export function decryptBankToken(encoded: string, connectionId: string, material: BankingKeyRing | Buffer): string {
  try {
    const ring = ringOf(material);
    const envelope = JSON.parse(encoded) as Envelope;
    if (envelope.version === 1) {
      if (ring.environment !== "sandbox" || envelope.key_id !== "sandbox-v1") throw new Error();
    } else if (envelope.version === 2) {
      if (ring.environment !== "production" || !PRODUCTION_KEY_ID.test(envelope.key_id)) throw new Error();
    } else throw new Error();
    const selected = ring.byId(envelope.key_id);
    if (!selected || selected.key.length !== 32) throw new Error();
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", selected.key, iv);
    decipher.setAAD(aadFor(ring.environment, connectionId, envelope.key_id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new BankingError("BANKING_TOKEN_DECRYPTION_FAILED", 503);
  }
}

/** Key id an existing ciphertext was written with; the rotation helper re-encrypts everything that is not active. */
export function envelopeKeyId(encoded: string): string | null {
  try {
    const envelope = JSON.parse(encoded) as Partial<Envelope>;
    return typeof envelope.key_id === "string" ? envelope.key_id : null;
  } catch { return null; }
}

export function bankingErrorCode(error: unknown): string {
  return error instanceof BankingError ? error.code : "BANKING_OPERATION_FAILED";
}
