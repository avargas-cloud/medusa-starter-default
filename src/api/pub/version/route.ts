import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /pub/version
 *
 * Publicly accessible deployment-version endpoint — no auth, no publishable key
 * (lives under /pub/* so Medusa's admin/store middleware never applies; open CORS
 * is handled by pubCorsMiddleware in src/api/middlewares.ts).
 *
 * The POS polls this (via its own /api/version proxy) to know when the backend
 * has been redeployed, so it can nudge the cashier to refresh.
 *
 * `version` prefers the git SHA when Railway injects it, and otherwise falls back
 * to BOOTED_AT — a timestamp captured once at module load. A new Railway deploy
 * always spawns a fresh process, so BOOTED_AT changes on every redeploy even when
 * the SHA env var is absent.
 */

// Captured once, at module load.
const BOOTED_AT = new Date().toISOString();

const SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  "";

export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({
    version: SHA || BOOTED_AT,
    sha: SHA || null,
    bootedAt: BOOTED_AT,
  });
};
