import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { bridgeFetch } from "../../../../lib/quickbooks/client/core";

/**
 * GET  /admin/quickbooks/bridge  — queue stats from the bridge
 * POST /admin/quickbooks/bridge  — action dispatch (body: { action: "reset-busy" })
 */

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  try {
    const stats = await bridgeFetch("GET", "/api/sync/queue-stats");
    res.json({ success: true, ...stats });
  } catch (err: any) {
    res.status(502).json({ success: false, error: err.message });
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { action } = (req.body ?? {}) as { action?: string };

  if (action === "reset-busy") {
    try {
      const result = await bridgeFetch("POST", "/api/sync/reset-busy");
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message });
    }
    return;
  }

  if (action === "purge") {
    try {
      const result = await bridgeFetch("POST", "/api/sync/queue/purge");
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message });
    }
    return;
  }

  res.status(400).json({ success: false, error: `Unknown action: ${action}` });
}
