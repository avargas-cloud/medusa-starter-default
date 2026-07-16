import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getRedis } from "../../../../lib/redis-client";

/**
 * GET /pub/s/:slug
 *
 * Public short-URL redirect. Looks up the slug in Redis and 302-redirects
 * to the real MinIO pdf-shares URL. Slugs expire after 30 days (same as
 * the MinIO lifecycle on pdf-shares/).
 *
 * Used by the POS WhatsApp send flow to replace long MinIO URLs with a
 * branded short link like `https://<backend>/pub/s/abc12345`.
 */

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { slug } = req.params as { slug: string };

  if (!slug || !/^[A-Za-z0-9_-]{4,32}$/.test(slug)) {
    res.status(400).send("Invalid slug");
    return;
  }

  try {
    const redis = getRedis();
    const target = await redis.get(`pdf-share:${slug}`);

    if (!target) {
      res.status(404).send("Link expired or not found");
      return;
    }

    // Defense-in-depth: only redirect to our own MinIO bucket.
    // Prevents turning /pub/s/* into an open-redirect gadget if Redis is ever
    // poisoned via another surface.
    const minioBase = process.env.MINIO_ENDPOINT;
    if (!minioBase || !target.startsWith(minioBase.replace(/\/$/, "") + "/")) {
      console.error("[pdf-share] blocked suspicious redirect target:", target);
      res.status(500).send("Internal error");
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.redirect(302, target);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[pdf-share] redirect error:", message);
    res.status(500).send("Internal error");
  }
}
