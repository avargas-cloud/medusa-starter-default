/**
 * src/api/admin/china-adjustment/reserved/route.ts
 *
 * POST /admin/china-adjustment/reserved
 * Body: { inventory_item_ids: string[] }
 *
 * Returns China reservation units split by transfer status for the given items:
 *   { reserved: { [inventory_item_id]: { committed, in_transit } } }
 *
 * committed  = reserved by CONFIRMED transfers (still physically in China).
 * in_transit = reserved by SHIPPED transfers (already left China).
 * Missing ids simply have no entry (treat as 0 client-side).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  getActorUserId,
  UnauthenticatedError,
} from "../../purchase-orders/_lib/auth";
import { loadChinaReservedByItem, type KnexRaw } from "../_lib/china-line-data";

function resolveKnex(req: AuthenticatedMedusaRequest): KnexRaw {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexRaw;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const body = req.body as { inventory_item_ids?: unknown };
  const ids = Array.isArray(body.inventory_item_ids)
    ? body.inventory_item_ids.filter((v): v is string => typeof v === "string")
    : [];

  if (ids.length === 0) return res.json({ reserved: {} });

  try {
    const knex = resolveKnex(req);
    const map = await loadChinaReservedByItem(knex, ids.slice(0, 2000));
    const reserved: Record<string, { committed: number; in_transit: number }> =
      {};
    for (const [id, v] of map) reserved[id] = v;
    return res.json({ reserved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load";
    return res.status(422).json({ error: message, code: "reserved_lookup_failed" });
  }
}
