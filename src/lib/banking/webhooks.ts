import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { getDbPool } from "../../api/utils/db-pool";
import { BankingError, bankingConfig, bankingEnvSql, bankingErrorCode, requireBankingEnabled } from "./security";
import { bankingLimits, limitCode } from "./limits";
import { object, plaidRequest, string } from "./plaid";
import { bankId, transaction } from "./store";

/** Key resolution is injectable for signature tests, never selectable by an HTTP caller. */
export async function verifyBankWebhook(raw: Buffer, signature: string,
  getKey: (kid: string) => Promise<JWK> = async (kid) => object((await plaidRequest("/webhook_verification_key/get", { key_id: kid })).key),
) {
  try {
    if (raw.length > 65536 || signature.length > 10000) throw new Error();
    const header = decodeProtectedHeader(signature);
    if (header.alg !== "ES256" || !header.kid || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) throw new Error();
    const jwk = await getKey(header.kid);
    if (jwk.alg !== "ES256" || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.kid !== header.kid || jwk.expired_at != null) throw new Error();
    const key = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(signature, key, { algorithms: ["ES256"], maxTokenAge: "5 min" });
    if (typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 30) throw new Error();
    if (typeof payload.request_body_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.request_body_sha256)) throw new Error();
    const digest = createHash("sha256").update(raw).digest();
    if (!timingSafeEqual(digest, Buffer.from(payload.request_body_sha256, "hex"))) throw new Error();
    return object(JSON.parse(raw.toString("utf8")));
  } catch { throw new BankingError("BANKING_INVALID_WEBHOOK_SIGNATURE", 401); }
}

export async function receiveBankWebhook(raw: Buffer, signature: string) {
  requireBankingEnabled();
  const payload = await verifyBankWebhook(raw, signature);
  if (payload.environment !== bankingConfig().environment) throw new BankingError("BANKING_WEBHOOK_ENVIRONMENT_MISMATCH", 400);
  const itemId = string(payload.item_id);
  const eventType = `${string(payload.webhook_type)}:${string(payload.webhook_code)}`;
  const digest = createHash("sha256").update(signature).update(raw).digest("hex");
  const client = await getDbPool().connect();
  try {
    await transaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('banking-sandbox-cap', 7241))");
      const duplicate = await client.query("SELECT id FROM bank_webhook_event WHERE event_digest=$1", [digest]);
      if (duplicate.rowCount) return;
      const cap = bankingLimits().webhookEvents;
      if (cap !== null) {
        const count = await client.query<{ count: string }>("SELECT count(*) FROM bank_webhook_event");
        if (Number(count.rows[0]?.count) >= cap) throw new BankingError(limitCode("WEBHOOK"), 409);
      }
      await client.query(`INSERT INTO bank_webhook_event(id,provider,environment,connection_id,event_digest,event_type,payload,received_at)
        VALUES($1,'plaid',${bankingEnvSql()},(SELECT id FROM bank_connection WHERE provider_item_id=$2
          AND environment=${bankingEnvSql()} AND deleted_at IS NULL),$3,$4,$5::jsonb,now())`,
      [bankId("bwevt"), itemId, digest, eventType, JSON.stringify(payload)]);
    });
  } finally { client.release(); }
  await drainBankWebhooks();
  return { received: true };
}

/** A durable inbox makes a crash after acknowledgement recoverable. */
export async function drainBankWebhooks() {
  requireBankingEnabled();
  for (let i = 0; i < 50; i++) {
    const client = await getDbPool().connect();
    let eventId: string | undefined;
    try {
      const processed = await transaction(client, async () => {
        const result = await client.query<{ id: string; connection_id: string | null; event_type: string; payload: Record<string, unknown> }>(
          `SELECT id,connection_id,event_type,payload FROM bank_webhook_event
           WHERE environment=${bankingEnvSql()} AND status IN ('pending','failed') AND attempts<6
           AND (status='pending' OR updated_at<now()-interval '1 minute')
           ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const event = result.rows[0];
        if (!event) return false;
        eventId = event.id;
        const itemId = typeof event.payload.item_id === "string" ? event.payload.item_id : "";
        const connection = await client.query<{ id: string }>(`SELECT id FROM bank_connection
          WHERE provider_item_id=$1 AND environment=${bankingEnvSql()} AND deleted_at IS NULL`, [itemId]);
        const connectionId = connection.rows[0]?.id;
        if (!connectionId) throw new BankingError("BANKING_WEBHOOK_ITEM_UNKNOWN", 409);
        // Same key as the session lock held by sync/actions. If busy, commit
        // without consuming an attempt; the durable event remains pending.
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 7241)) AS locked", [connectionId]);
        if (!lock.rows[0]?.locked) return false;
        // Re-read after acquiring the lock: disconnect may have completed
        // between the first lookup and acquisition. Late events never revive it.
        const current = await client.query<{ status: string }>(
          "SELECT status FROM bank_connection WHERE id=$1 AND deleted_at IS NULL", [connectionId]);
        if (!current.rows[0]) throw new BankingError("BANKING_WEBHOOK_ITEM_UNKNOWN", 409);
        const error = event.payload.error && typeof event.payload.error === "object" ? object(event.payload.error).error_code : null;
        const loginRequired = error === "ITEM_LOGIN_REQUIRED";
        const pending = ["ITEM:PENDING_DISCONNECT", "ITEM:PENDING_EXPIRATION"].includes(event.event_type);
        const revoked = event.event_type === "ITEM:USER_PERMISSION_REVOKED";
        const repaired = event.event_type === "ITEM:LOGIN_REPAIRED";
        if (current.rows[0].status !== "disconnected") {
          await client.query(`UPDATE bank_connection SET sync_requested_at=now(),
            pending_disconnect=CASE WHEN $4::boolean THEN false
              WHEN $2::boolean THEN true ELSE pending_disconnect END,
            status=CASE WHEN $3::boolean THEN 'reauth_required'
              WHEN $4::boolean THEN CASE WHEN EXISTS(SELECT 1 FROM bank_account
                WHERE connection_id=$1 AND is_selected AND is_active AND deleted_at IS NULL)
                THEN 'active' ELSE 'awaiting_selection' END ELSE status END,
            last_error_code=CASE WHEN $3::boolean THEN 'ITEM_LOGIN_REQUIRED'
              WHEN $4::boolean THEN NULL ELSE last_error_code END,
            last_error_message=CASE WHEN $4::boolean THEN NULL ELSE last_error_message END,
            updated_at=now() WHERE id=$1`, [connectionId, pending, loginRequired || revoked, repaired]);
        }
        await client.query(`UPDATE bank_webhook_event SET connection_id=$2,status='processed',attempts=attempts+1,
          processed_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1`, [event.id, connectionId]);
        return true;
      });
      if (!processed) return;
    } catch (error) {
      if (eventId) await client.query(`UPDATE bank_webhook_event SET status='failed',attempts=attempts+1,
        last_error_code=$2,updated_at=now() WHERE id=$1`, [eventId, bankingErrorCode(error)]);
      else throw error;
    } finally { client.release(); }
  }
}
