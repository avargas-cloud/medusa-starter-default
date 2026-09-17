/**
 * Lo que comparten las rutas de /admin/pos/calendar: resolver el objetivo
 * (usuario autenticado, o `user_id` si el que pide es owner), traducir errores
 * y el handle pg. Ver `lib/calendar/personal-calendar.ts` para las reglas.
 */
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { GoogleCalendarError } from "../../../../../lib/calendar/google-calendar-client";
import { resolveCalendarTarget, type CalendarTarget } from "../../../../../lib/calendar/personal-calendar";
import type { RawPg } from "../../../../../lib/calendar/recurring-repo";
import { PosAccessError } from "../../../../../lib/pos/access-level";

export function pgOf(req: MedusaRequest): RawPg {
  return req.scope.resolve("__pg_connection__") as RawPg;
}

export function requestedUserId(req: MedusaRequest): string | null {
  const v = (req.query as Record<string, unknown>).user_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Resuelve el objetivo o contesta el error; null = ya contestó. */
export async function targetOrRespond(req: MedusaRequest, res: MedusaResponse, pg: RawPg): Promise<CalendarTarget | null> {
  try {
    return await resolveCalendarTarget(req as AuthenticatedMedusaRequest, pg, requestedUserId(req));
  } catch (error) {
    if (error instanceof PosAccessError) {
      res.status(error.status).json({ error: error.code, code: error.code });
      return null;
    }
    throw error;
  }
}

/** Un error de Google se resume (nunca se filtra la clave ni el body crudo). */
export function googleFailure(res: MedusaResponse, error: unknown, fallback: string): void {
  if (error instanceof GoogleCalendarError) {
    res.status(error.status === 403 ? 502 : error.status).json({
      error: error.status === 403 ? "Google rejected the request (check the calendar scope)" : error.message,
      code: "GOOGLE_CALENDAR_ERROR",
    });
    return;
  }
  res.status(500).json({ error: fallback });
}

/** Contesta 409 si la cuenta no puede tener calendario. */
export function unavailable(res: MedusaResponse, target: CalendarTarget): boolean {
  if (target.availability === "ok") return false;
  res.status(409).json({
    error:
      target.availability === "not_configured"
        ? "Google Calendar is not configured on this server"
        : "This account is outside the company Google domain",
    code: target.availability === "not_configured" ? "CALENDAR_NOT_CONFIGURED" : "CALENDAR_UNAVAILABLE",
    availability: target.availability,
    target: target.target,
  });
  return true;
}
