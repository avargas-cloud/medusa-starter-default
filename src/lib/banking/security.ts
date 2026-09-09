import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class BankingError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

/** This delivery deliberately cannot select Plaid Production credentials. */
export function bankingConfig() {
  const enabled = process.env.ECOPOWERTECH_ENV === "sandbox";
  return {
    enabled,
    environment: "sandbox" as const,
    unavailable_reason: enabled ? null : "BANKING_SANDBOX_ONLY",
  };
}

export function requireBankingSandbox() {
  if (!bankingConfig().enabled) throw new BankingError("BANKING_SANDBOX_ONLY", 503);
  let target: URL;
  try { target = new URL(process.env.DATABASE_URL || ""); }
  catch { throw new BankingError("BANKING_DATABASE_NOT_CONFIGURED", 503); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.port !== "5499" || target.pathname !== "/medusa") {
    throw new BankingError("BANKING_SANDBOX_DATABASE_REQUIRED", 503);
  }
}

/** Dedicated random 256-bit key; never derive from Plaid, JWT or cookie secrets. */
export function sandboxTokenKey(): Buffer {
  requireBankingSandbox();
  const value = process.env.BANKING_SANDBOX_TOKEN_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new BankingError("BANKING_ENCRYPTION_KEY_REQUIRED", 503);
  }
  return Buffer.from(value, "hex");
}

type Envelope = { version: 1; key_id: "sandbox-v1"; iv: string; tag: string; ciphertext: string };

/** Bind each ciphertext to its environment and stable connection identity. */
export function encryptBankToken(token: string, connectionId: string, key: Buffer): string {
  if (key.length !== 32 || !token || !connectionId) throw new BankingError("BANKING_ENCRYPTION_INVALID");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`banking:sandbox:${connectionId}:v1`));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const envelope: Envelope = {
    version: 1, key_id: "sandbox-v1", iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptBankToken(encoded: string, connectionId: string, key: Buffer): string {
  try {
    const envelope = JSON.parse(encoded) as Envelope;
    if (envelope.version !== 1 || envelope.key_id !== "sandbox-v1" || key.length !== 32) throw new Error();
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`banking:sandbox:${connectionId}:v1`));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new BankingError("BANKING_TOKEN_DECRYPTION_FAILED", 503);
  }
}

export function bankingErrorCode(error: unknown): string {
  return error instanceof BankingError ? error.code : "BANKING_OPERATION_FAILED";
}
