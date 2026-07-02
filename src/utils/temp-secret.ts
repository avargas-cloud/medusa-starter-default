import crypto from "crypto";

/**
 * Reversible encryption for short-lived secrets that must survive at rest but
 * NEVER be readable as plaintext in the DB — e.g. the `temporary_password`
 * stashed on a legacy customer between registration and activation.
 *
 * AES-256-GCM. Key derived (scrypt) from COOKIE_SECRET (fallback JWT_SECRET).
 * Ciphertext format: `enc:v1:<iv>:<tag>:<ciphertext>` (all base64).
 *
 * `decryptSecret` is backward-compatible: any value WITHOUT the `enc:v1:`
 * prefix is returned verbatim, so records that stored plaintext before this
 * change (activations already in flight) keep working.
 */

const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const secret =
    process.env.COOKIE_SECRET || process.env.JWT_SECRET || "";
  if (!secret) {
    throw new Error(
      "temp-secret: COOKIE_SECRET/JWT_SECRET must be set to encrypt secrets"
    );
  }
  // Static salt is acceptable here: the key is process-wide and the value is
  // short-lived; per-message uniqueness comes from the random IV.
  return crypto.scryptSync(secret, "ept-temp-secret-v1", 32);
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString(
    "base64"
  )}:${ct.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  // Backward compat: legacy plaintext (no prefix) passes through untouched.
  if (!value || !value.startsWith(PREFIX)) {
    return value;
  }
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("temp-secret: malformed ciphertext");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
