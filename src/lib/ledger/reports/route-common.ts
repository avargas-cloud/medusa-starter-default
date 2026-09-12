import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import type { SqlClient } from "../../accounting/month-close-data";
import {
  accessFailure,
  assertAccounting,
  PosAccessError,
} from "../../pos/access-level";

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dbFrom(req: AuthenticatedMedusaRequest): SqlClient {
  return req.scope.resolve("__pg_connection__") as SqlClient;
}

/**
 * Read access to the GL reports = Accounting (owner or live grant in
 * `pos_accounting_grant`), resolved by `lib/pos/access-level` — the same
 * authority behind `requireFullAdmin`. On denial writes `{error, code}` with
 * the guard's status and returns false; the route then returns.
 * `verify-accounting-guard.ts` lists this helper as a delegate.
 */
export async function requireAccountingOr403(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<boolean> {
  try {
    await assertAccounting(req);
    return true;
  } catch (error) {
    if (error instanceof PosAccessError) {
      accessFailure(res, error);
      return false;
    }
    throw error;
  }
}

export function queryString(
  req: AuthenticatedMedusaRequest,
  key: string
): string | null {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function invalidRange(res: MedusaResponse, what = "from and to") {
  return res.status(400).json({
    error: `${what} are required in YYYY-MM-DD format, with from <= to`,
    code: "invalid_range",
  });
}

export function isDay(value: string | null): value is string {
  return value !== null && DAY_RE.test(value);
}
