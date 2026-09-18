/** GET /admin/pos/cash-close/records?from&to&limit=100 — no snapshot, totals yes. */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { listCashCloses } from "../../../../../lib/cash-close/service";
import type { Knexish } from "../../../../../lib/cash-close/load-day";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }

  const fromParam = req.query.from;
  const toParam = req.query.to;
  const from = typeof fromParam === "string" ? fromParam : undefined;
  const to = typeof toParam === "string" ? toParam : undefined;
  if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) {
    res.status(400).json({ error: "CASH_CLOSE_INVALID_DAY" });
    return;
  }
  const limitParam = req.query.limit;
  const limit =
    typeof limitParam === "string" && Number.isFinite(Number(limitParam))
      ? Number(limitParam)
      : 100;

  const knex = req.scope.resolve("__pg_connection__") as unknown as Knexish;
  try {
    const records = await listCashCloses(knex, { from, to, limit });
    res.json({ records });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cash-close] GET records failed: ${message}`);
    res.status(500).json({ error: "CASH_CLOSE_LIST_FAILED", message });
  }
}
