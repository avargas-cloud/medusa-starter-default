import type { MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { LedgerError } from "../types";

import type { ListFilters } from "./manual-list";

/**
 * Piezas HTTP compartidas por las rutas de documentos manuales
 * (`/admin/accounting/{journal-entries,checks,transfers}`, `ledger/year-close`):
 * parseo de filtros de listado, schemas zod comunes y el mapeo de
 * `LedgerError` a status. La autorización NO vive acá: cada ruta llama
 * `assertAccounting(req)` directo (es lo que audita `verify-accounting-guard`).
 */

export const DAY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD");
export const CENTS_SCHEMA = z
  .number()
  .int()
  .min(-999_999_999_999)
  .max(999_999_999_999);
export const REASON_SCHEMA = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const MEMO_SCHEMA = z.string().trim().max(2000).nullable().optional();
export const OPTIONAL_ID_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .nullable()
  .optional();

/** Status HTTP por código — mismo criterio que la ruta de opening-balances. */
export function ledgerErrorStatus(code: LedgerError["code"]): number {
  switch (code) {
    case "GL_DOCUMENT_NOT_FOUND":
      return 404;
    case "GL_ALREADY_POSTED":
    case "GL_ACCOUNT_MAP_MISSING":
    case "GL_PERIOD_CLOSED":
    case "GL_DOCUMENT_NOT_DRAFT":
    case "GL_DOCUMENT_NOT_POSTED":
      return 409;
    case "GL_UNBALANCED_DOCUMENT":
      return 400;
    default:
      return 400;
  }
}

/** `{ error, code, details }` para un `LedgerError`; cualquier otra cosa se relanza. */
export function ledgerFailure(res: MedusaResponse, error: unknown): void {
  if (error instanceof LedgerError) {
    res
      .status(ledgerErrorStatus(error.code))
      .json({ error: error.message, code: error.code, details: error.details });
    return;
  }
  throw error;
}

export function invalidBody(
  res: MedusaResponse,
  issue: string | undefined
): void {
  res
    .status(400)
    .json({ error: issue ?? "Invalid body", code: "invalid_body" });
}

const STATUSES = new Set(["draft", "posted", "voided"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Filtros de `GET` de listado: `from,to,status,account_list_id,q,limit,cursor`. Lanza `GL_SOURCE_INVALID` si un filtro está mal formado. */
export function parseListFilters(query: Record<string, unknown>): ListFilters {
  const from = str(query.from);
  const to = str(query.to);
  const status = str(query.status);
  if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to)))
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "invalid_range" });
  if (status && !STATUSES.has(status))
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "invalid_status",
      status,
    });
  const rawLimit = Number.parseInt(String(query.limit ?? "50"), 10);
  return {
    from,
    to,
    status,
    account_list_id: str(query.account_list_id),
    q: str(query.q),
    limit: Number.isFinite(rawLimit) ? rawLimit : 50,
    cursor: str(query.cursor),
  };
}
