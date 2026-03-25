/**
 * Document Locking API — Redis Pessimistic Locking (F1.1 – F1.4)
 *
 * POST   /admin/documents/:type/:id/lock           — Acquire lock
 * POST   /admin/documents/:type/:id/lock/heartbeat — Renew TTL
 * DELETE /admin/documents/:type/:id/lock           — Release lock (owner or admin)
 * GET    /admin/documents/:type/:id/lock           — Check lock status
 *
 * Lock key schema: lock:{type}:{id}
 * Lock value:      JSON { userId, userName, token, lockedAt }
 * TTL:             60 seconds (renewed every 30s by client heartbeat)
 *
 * Best practices applied:
 *  - Atomic SET NX EX (acquire or fail in one command)
 *  - Lua script for safe release (owner-only delete, prevents accidental unlock)
 *  - Unique per-session token (UUID) stored in value, sent by client in X-Lock-Token header
 *  - Admin bypass: header X-Force-Unlock: true skips owner check
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { randomUUID } from 'crypto'
import { getRedis } from '../../../../../../lib/redis-client'

const LOCK_TTL = 60 // seconds
const LOCK_PREFIX = 'pos:lock'

function lockKey(type: string, id: string) {
  return `${LOCK_PREFIX}:${type}:${id}`
}

// Lua script: delete only if value matches token (atomic owner check + delete)
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) then
    local data = cjson.decode(redis.call("get", KEYS[1]))
    if data["token"] == ARGV[1] or ARGV[2] == "force" then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  else
    return 1
  end
`

function resolveRedis(_req: MedusaRequest) {
  // Medusa v2 does NOT expose ioredis in its DI container.
  // Use the singleton client from lib/redis-client.ts instead.
  return getRedis()
}

// ── POST /admin/documents/:type/:id/lock ─────────────────────────────────────
// Acquire lock. Returns 200 (acquired) or 409 (already locked).
// sessionId uniquely identifies a browser tab — two tabs of the same user
// are treated as different sessions and cannot both hold the lock.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { type = '', id = '' } = req.params
  const redis = resolveRedis(req)
  const key = lockKey(type, id)

  const { userId, userName, sessionId } = req.body as { userId: string; userName: string; sessionId?: string }
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' })
  }

  const lockToken = randomUUID()
  const payload = JSON.stringify({
    userId,
    userName: userName || userId,
    sessionId: sessionId || lockToken,  // fallback for older clients
    token: lockToken,
    lockedAt: new Date().toISOString(),
  })

  // Atomic: SET key payload EX 60 NX
  const result = await redis.set(key, payload, 'EX', LOCK_TTL, 'NX')

  if (result === 'OK') {
    return res.status(200).json({ locked: true, token: lockToken, message: 'Lock acquired' })
  }

  // Key exists — check if it's the exact same session (same browser tab)
  const existing = await redis.get(key)
  if (existing) {
    const data = JSON.parse(existing)
    if (sessionId && data.sessionId === sessionId) {
      // Same tab reconnecting (e.g. React StrictMode double-mount) — renew TTL
      await redis.expire(key, LOCK_TTL)
      return res.status(200).json({ locked: true, token: data.token, message: 'Lock renewed (same session)' })
    }

    // NEW LOGIC: Self-Hijacking with BroadcastChannel Validation
    // If the browser killed the keepalive DELETE during an F5 refresh, the lock stays as a "Zombie" for 60s.
    // The frontend's BroadcastChannel checks if the other tab is dead. If it is dead, it sends x-hijack-zombie: true.
    // If the EXACT SAME userId asks to hijack, and explicitly provides the header, steal it.
    const isHijackRequest = req.headers['x-hijack-zombie'] === 'true'
    if (data.userId === userId && isHijackRequest) {
      const hijackedPayload = JSON.stringify({
        userId,
        userName,
        sessionId: sessionId || lockToken,
        token: lockToken,
        lockedAt: new Date().toISOString(),
      })
      await redis.set(key, hijackedPayload, 'EX', LOCK_TTL)
      return res.status(200).json({ locked: true, token: lockToken, message: 'Lock hijacked by same user (zombie/refresh)' })
    }

    // Different session (including completely different users) — 409 Conflict
    return res.status(409).json({
      error: 'Document is locked',
      userId: data.userId,
      lockedBy: data.userName,
      lockedAt: data.lockedAt,
    })
  }

  return res.status(409).json({ error: 'Failed to acquire lock, try again' })
}


// ── DELETE /admin/documents/:type/:id/lock ────────────────────────────────────
// Release lock:
//   - Owner: sends x-lock-token matching the lock's token (Lua atomic check)
//   - Force:  sends x-force-unlock: true + x-unlock-code matching FORCE_UNLOCK_CODE env var
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const { type = '', id = '' } = req.params
  const redis = resolveRedis(req)
  const key = lockKey(type, id)

  const token = (req.headers['x-lock-token'] as string) || (req.body as any)?.token
  const isForceRequest = req.headers['x-force-unlock'] === 'true'

  // ── Force unlock path: validate server-side secret code ─────────────────────
  if (isForceRequest) {
    const serverCode = process.env.FORCE_UNLOCK_CODE
    const clientCode = (req.headers['x-unlock-code'] as string) || (req.body as any)?.unlockCode

    if (!serverCode) {
      return res.status(503).json({ error: 'Force unlock not configured on server' })
    }
    if (!clientCode || clientCode !== serverCode) {
      return res.status(403).json({ error: 'Invalid authorization code' })
    }

    // Code is valid — delete unconditionally
    await redis.del(key)
    return res.status(200).json({ ok: true, released: true, method: 'force' })
  }

  // ── Owner unlock path: Lua atomic token check + delete ───────────────────────
  if (!token) {
    return res.status(400).json({ error: 'x-lock-token header required' })
  }

  const result = await redis.eval(
    RELEASE_SCRIPT,
    1,
    key,
    token,
    '' // not force
  )

  if (result === 1) {
    return res.status(200).json({ ok: true, released: true })
  }
  return res.status(403).json({ error: 'Token mismatch — you do not own this lock' })
}


// ── GET /admin/documents/:type/:id/lock ───────────────────────────────────────
// Check lock status (safe for polling by non-owners every 15s).
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { type = '', id = '' } = req.params
  const redis = resolveRedis(req)
  const key = lockKey(type, id)

  const existing = await redis.get(key)
  if (!existing) {
    return res.status(200).json({ locked: false })
  }

  const data = JSON.parse(existing)
  const ttl = await redis.ttl(key) // remaining seconds

  return res.status(200).json({
    locked: true,
    lockedBy: data.userName,
    lockedAt: data.lockedAt,
    expiresIn: ttl,
  })
}
