/**
 * POST /admin/documents/:type/:id/lock/heartbeat
 * Renew lock TTL — called every 30s by the document owner.
 * Fails with 410 if the lock has expired, or 403 if token doesn't match.
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getRedis } from "../../../../../../../lib/redis-client";

const LOCK_TTL = 60;
const LOCK_PREFIX = "pos:lock";

function resolveRedis(_req: MedusaRequest) {
  return getRedis();
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { type, id } = req.params;
  const redis = resolveRedis(req);
  const key = `${LOCK_PREFIX}:${type}:${id}`;

  const token =
    (req.headers["x-lock-token"] as string) || (req.body as any)?.token;

  if (!token) {
    return res
      .status(400)
      .json({ error: "x-lock-token header or body.token required" });
  }

  const existing = await redis.get(key);
  if (!existing) {
    return res
      .status(410)
      .json({ error: "Lock expired — document is now unlocked" });
  }

  const data = JSON.parse(existing);
  if (data.token !== token) {
    return res
      .status(403)
      .json({ error: "Token mismatch — you do not own this lock" });
  }

  await redis.expire(key, LOCK_TTL);
  const ttl = await redis.ttl(key);

  return res.status(200).json({ ok: true, expiresIn: ttl });
}
