/**
 * GET/POST /admin/pos/calendar/events — el calendario personal del usuario del
 * POS (Google Calendar, calendario secundario "EcoPowerTech POS").
 *
 * GET ?from&to[&user_id]: eventos del rango. `user_id` sólo lo honra un owner.
 * Una cuenta fuera del dominio recibe 200 con `availability: 'unavailable'` y
 * cero eventos (la pantalla lo explica); la escritura ahí contesta 409.
 * POST [?user_id]: crea un evento en ese calendario.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { insertEvent, listEvents } from "../../../../../lib/calendar/google-calendar-client";
import { ensurePosCalendar, parsePersonalEvent } from "../../../../../lib/calendar/personal-calendar";
import { ISO_DATE_RE } from "../../../../../lib/calendar/recurring-types";

import { googleFailure, pgOf, targetOrRespond, unavailable } from "../_lib/target";

const MAX_RANGE_DAYS = 120;

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = pgOf(req);
  const target = await targetOrRespond(req, res, pg);
  if (!target) return;
  const q = req.query as Record<string, unknown>;
  const from = String(q.from ?? "");
  const to = String(q.to ?? "");
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return res.status(400).json({ error: "from/to must be YYYY-MM-DD with from <= to" });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `range must not exceed ${MAX_RANGE_DAYS} days` });
  }
  const base = { availability: target.availability, target: target.target, users: target.users, is_owner: target.isOwner, from, to };
  if (target.availability !== "ok") return res.json({ ...base, events: [] });
  try {
    const calendarId = await ensurePosCalendar(pg, target.target);
    const events = await listEvents(target.target.email, calendarId, from, to);
    return res.json({ ...base, events });
  } catch (error) {
    return googleFailure(res, error, "Failed to load calendar events");
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const pg = pgOf(req);
  const target = await targetOrRespond(req, res, pg);
  if (!target) return;
  if (unavailable(res, target)) return;
  const parsed = parsePersonalEvent(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const calendarId = await ensurePosCalendar(pg, target.target);
    const event = await insertEvent(target.target.email, calendarId, parsed.value);
    return res.status(201).json({ event });
  } catch (error) {
    return googleFailure(res, error, "Failed to create the event");
  }
}
