/**
 * src/api/admin/china-adjustment/china-products/route.ts
 *
 * GET /admin/china-adjustment/china-products
 *
 * China-scoped item source for the China Inventory Adjustment screen. Only
 * returns variants whose product is flagged `is_sourced_via_agent = true`
 * (China-sourced via the agent). Powers both the typeahead search (`q`) and the
 * bulk-add-by-prefix / load-all flows (`prefixes`, or no filter = all).
 *
 * Query params:
 *   q          — free-text typeahead over sku + title (optional)
 *   prefixes   — comma-separated SKU prefixes, e.g. "ECT,EPS" (optional)
 *   ids        — comma-separated inventory_item_ids to enrich (optional)
 *   limit      — max rows (default 1000, cap 5000)
 *
 * Each item carries china_stock (available), committed (confirmed transfers,
 * still in China) and in_transit (shipped transfers, gone) — see
 * `_lib/china-line-data.ts`.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  getActorUserId,
  UnauthenticatedError,
} from "../../purchase-orders/_lib/auth";
import { loadChinaProductLines, type KnexRaw } from "../_lib/china-line-data";

function resolveKnex(req: AuthenticatedMedusaRequest): KnexRaw {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexRaw;
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

export async function GET(
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

  const query = req.query as Record<string, string | undefined>;
  const q = query.q?.trim() || undefined;
  const prefixes = splitCsv(query.prefixes);
  const ids = splitCsv(query.ids);
  const limit = query.limit ? parseInt(query.limit, 10) : undefined;

  try {
    const knex = resolveKnex(req);
    const items = await loadChinaProductLines(knex, {
      q,
      prefixes,
      inventoryItemIds: ids.length > 0 ? ids : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return res.json({ items, count: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load";
    return res.status(422).json({ error: message, code: "china_products_failed" });
  }
}
