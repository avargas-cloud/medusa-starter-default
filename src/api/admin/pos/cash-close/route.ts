/**
 * GET  /admin/pos/cash-close?day=YYYY-MM-DD — snapshot for the day (recomputed
 *      live, never stored) plus whatever closes already exist for it.
 * POST /admin/pos/cash-close { day } — files a close. 409 when the day is not
 *      balanced (unexplained money): the route stores nothing in that case.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  CashCloseNotBalancedError,
  computeCashClose,
  createCashClose,
  latestClosableDay,
  CashCloseDayNotClosedError,
} from "../../../../lib/cash-close/service";
import {
  loadExistingClosesForDay,
  type Knexish,
} from "../../../../lib/cash-close/load-day";
import type { CashCloseTotals } from "../../../../lib/cash-close/types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveKnex(req: AuthenticatedMedusaRequest): Knexish {
  return req.scope.resolve("__pg_connection__") as unknown as Knexish;
}

interface ExistingCloseView {
  id: string;
  number: string;
  business_day: string;
  balanced: boolean;
  totals: CashCloseTotals;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  superseded_by: string | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }

  const dayParam = req.query.day;
  const day =
    typeof dayParam === "string" && dayParam.length > 0
      ? dayParam
      : latestClosableDay();
  if (!DAY_RE.test(day)) {
    res.status(400).json({ error: "CASH_CLOSE_INVALID_DAY", message: `Expected YYYY-MM-DD, received "${day}"` });
    return;
  }

  const knex = resolveKnex(req);
  try {
    const [snapshot, existingRows] = await Promise.all([
      computeCashClose(knex, day),
      loadExistingClosesForDay(knex, day),
    ]);
    const existing: ExistingCloseView[] = existingRows.map((row) => ({
      id: row.id,
      number: row.number,
      business_day: row.business_day,
      balanced: row.balanced,
      totals: row.totals as CashCloseTotals,
      created_by: row.created_by,
      created_by_name: row.created_by_name,
      created_at: row.created_at,
      superseded_by: row.superseded_by,
    }));
    res.json({ snapshot, existing });
  } catch (err) {
    if (err instanceof CashCloseDayNotClosedError) {
      res.status(400).json({
        error: "CASH_CLOSE_DAY_NOT_CLOSED",
        message: `Only a finished business day can be closed (latest: ${latestClosableDay()})`,
        latest_day: latestClosableDay(),
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cash-close] GET failed: ${message}`);
    res.status(500).json({ error: "CASH_CLOSE_COMPUTE_FAILED", message });
  }
}

interface CreateBody {
  day?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }

  const body = req.body as CreateBody;
  const day = typeof body?.day === "string" ? body.day : "";
  if (!DAY_RE.test(day)) {
    res.status(400).json({ error: "CASH_CLOSE_INVALID_DAY", message: `Expected YYYY-MM-DD, received "${day}"` });
    return;
  }

  const knex = resolveKnex(req);
  try {
    const record = await createCashClose(knex, { day, actorId: userId });
    res.status(201).json({ record });
  } catch (err) {
    if (err instanceof CashCloseDayNotClosedError) {
      res.status(400).json({
        error: "CASH_CLOSE_DAY_NOT_CLOSED",
        message: `Only a finished business day can be closed (latest: ${latestClosableDay()})`,
        latest_day: latestClosableDay(),
      });
      return;
    }
    if (err instanceof CashCloseNotBalancedError) {
      res.status(409).json({
        error: "CASH_CLOSE_NOT_BALANCED",
        unexplained_cents: err.unexplained_cents,
        unexplained_count: err.unexplained_count,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cash-close] POST failed: ${message}`);
    res.status(500).json({ error: "CASH_CLOSE_CREATE_FAILED", message });
  }
}
