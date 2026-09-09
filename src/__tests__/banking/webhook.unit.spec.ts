import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { verifyBankWebhook } from "../../lib/banking/webhooks";

jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => { throw new Error("Webhook signature tests must not access a database"); },
}));

const kid = "fixture-public-key";
const raw = Buffer.from('{"environment":"sandbox","item_id":"fixture-item","webhook_type":"TRANSACTIONS"}');
let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  const generated = await generateKeyPair("ES256");
  privateKey = generated.privateKey;
  publicJwk = { ...await exportJWK(generated.publicKey), alg: "ES256", kid };
});

async function sign(body = raw, payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT({
    iat: Math.floor(Date.now() / 1000),
    request_body_sha256: createHash("sha256").update(body).digest("hex"),
    ...payload,
  }).setProtectedHeader({ alg: "ES256", kid, ...header }).sign(privateKey);
}

function keyResolver(jwk: JWK = publicJwk) {
  return jest.fn<Promise<JWK>, [string]>().mockResolvedValue(jwk);
}

const rejected = { code: "BANKING_INVALID_WEBHOOK_SIGNATURE", status: 401 };

describe("bank webhook authentication over original request bytes", () => {
  it("verifies a real ES256 signature and resolves only its declared key ID", async () => {
    const getKey = keyResolver();
    await expect(verifyBankWebhook(raw, await sign(), getKey)).resolves.toEqual(JSON.parse(raw.toString()));
    expect(getKey).toHaveBeenCalledWith(kid);
    expect(getKey).toHaveBeenCalledTimes(1);
  });

  it("rejects a modified body despite a valid signature for the original", async () => {
    const changed = Buffer.from(raw.toString().replace("fixture-item", "other-item"));
    await expect(verifyBankWebhook(changed, await sign(), keyResolver())).rejects.toMatchObject(rejected);
  });

  it("does not normalize whitespace before hashing, but accepts whitespace when signed exactly", async () => {
    const spaced = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
    await expect(verifyBankWebhook(spaced, await sign(), keyResolver())).rejects.toMatchObject(rejected);
    await expect(verifyBankWebhook(spaced, await sign(spaced), keyResolver())).resolves.toEqual(JSON.parse(raw.toString()));
  });

  it("rejects algorithm substitution before requesting a verification key", async () => {
    const signature = await new SignJWT({ iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "HS256", kid }).sign(Buffer.alloc(32, 11));
    const getKey = keyResolver();
    await expect(verifyBankWebhook(raw, signature, getKey)).rejects.toMatchObject(rejected);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("rejects a valid EC key that did not sign the request", async () => {
    const other = await generateKeyPair("ES256");
    const wrongKey = { ...await exportJWK(other.publicKey), alg: "ES256", kid };
    await expect(verifyBankWebhook(raw, await sign(), keyResolver(wrongKey))).rejects.toMatchObject(rejected);
  });

  it.each([
    { kid: "other-kid" }, { alg: "RS256" }, { kty: "RSA" }, { crv: "P-384" }, { expired_at: 0 },
  ])("rejects mismatched, retired or unsupported key metadata %#", async (patch) => {
    await expect(verifyBankWebhook(raw, await sign(), keyResolver({ ...publicJwk, ...patch }))).rejects.toMatchObject(rejected);
  });

  it.each([-301, 60])("rejects an issued-at time outside the permitted window: %s seconds", async (offset) => {
    const signature = await sign(raw, { iat: Math.floor(Date.now() / 1000) + offset });
    await expect(verifyBankWebhook(raw, signature, keyResolver())).rejects.toMatchObject(rejected);
  });

  it.each([undefined, "123", null])("rejects missing or nonnumeric issued-at %#", async (iat) => {
    await expect(verifyBankWebhook(raw, await sign(raw, { iat }), keyResolver())).rejects.toMatchObject(rejected);
  });

  it.each(["a".repeat(64), "A".repeat(64), "short", null])("rejects incorrect or malformed body digest %#", async (hash) => {
    await expect(verifyBankWebhook(raw, await sign(raw, { request_body_sha256: hash }), keyResolver())).rejects.toMatchObject(rejected);
  });

  it("fails safely when verification key retrieval fails", async () => {
    const getKey = jest.fn<Promise<JWK>, [string]>().mockRejectedValue(new Error("provider diagnostic containing confidential text"));
    await expect(verifyBankWebhook(raw, await sign(), getKey)).rejects.toMatchObject({ ...rejected, message: "BANKING_INVALID_WEBHOOK_SIGNATURE" });
  });

  it.each(["not-a-jwt", "x".repeat(10001)])("rejects malformed or oversized signatures before requesting a key %#", async (signature) => {
    const getKey = keyResolver();
    await expect(verifyBankWebhook(raw, signature, getKey)).rejects.toMatchObject(rejected);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before requesting a verification key", async () => {
    const getKey = keyResolver();
    await expect(verifyBankWebhook(Buffer.alloc(65537), await sign(), getKey)).rejects.toMatchObject(rejected);
    expect(getKey).not.toHaveBeenCalled();
  });

  it.each(["../untrusted", "", "a".repeat(129)])("rejects unsafe key IDs before attempting key resolution %#", async (keyId) => {
    const getKey = keyResolver();
    await expect(verifyBankWebhook(raw, await sign(raw, {}, { kid: keyId }), getKey)).rejects.toMatchObject(rejected);
    expect(getKey).not.toHaveBeenCalled();
  });

  it.each(["[]", "null", "not-json"])("rejects a correctly signed body that is not a JSON object %#", async (body) => {
    const bytes = Buffer.from(body);
    await expect(verifyBankWebhook(bytes, await sign(bytes), keyResolver())).rejects.toMatchObject(rejected);
  });
});
