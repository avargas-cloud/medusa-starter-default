/**
 * PATCH/DELETE /admin/pos/calendar/events/:eventId[?user_id] — editar o borrar
 * un evento del calendario "EcoPowerTech POS" del usuario (o del elegido, si
 * quien pide es owner). El scope de la Service Account no alcanza a ningún
 * otro calendario, así que un eventId ajeno simplemente no existe para ella.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { deleteEvent, updateEvent } from "../../../../../../lib/calendar/google-calendar-client";
import { ensurePosCalendar, parsePersonalEvent } from "../../../../../../lib/calendar/personal-calendar";

import { googleFailure, pgOf, targetOrRespond, unavailable } from "../../_lib/target";

function eventIdOf(req: MedusaRequest): string | null {
  const raw = String(req.params.eventId ?? "").trim();
  const id = raw.startsWith("gcal:") ? raw.slice(5) : raw;
  return /^[A-Za-z0-9_@.-]{5,1024}$/.test(id) ? id : null;
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const pg = pgOf(req);
  const target = await targetOrRespond(req, res, pg);
  if (!target) return;
  if (unavailable(res, target)) return;
  const eventId = eventIdOf(req);
  if (!eventId) return res.status(400).json({ error: "invalid event id" });
  const parsed = parsePersonalEvent(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const calendarId = await ensurePosCalendar(pg, target.target);
    const event = await updateEvent(target.target.email, calendarId, eventId, parsed.value);
    return res.json({ event });
  } catch (error) {
    return googleFailure(res, error, "Failed to update the event");
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const pg = pgOf(req);
  const target = await targetOrRespond(req, res, pg);
  if (!target) return;
  if (unavailable(res, target)) return;
  const eventId = eventIdOf(req);
  if (!eventId) return res.status(400).json({ error: "invalid event id" });
  try {
    const calendarId = await ensurePosCalendar(pg, target.target);
    await deleteEvent(target.target.email, calendarId, eventId);
    return res.json({ deleted: true });
  } catch (error) {
    return googleFailure(res, error, "Failed to delete the event");
  }
}
