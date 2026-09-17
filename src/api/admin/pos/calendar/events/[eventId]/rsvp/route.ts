/**
 * POST /admin/pos/calendar/events/:eventId/rsvp  { response: accepted|declined|tentative }
 *
 * Responde una invitación desde el POS, impersonando SIEMPRE al usuario
 * autenticado (una invitación es personal: acá no existe `?user_id`, ni para
 * el owner). Resuelve el aviso `calendar_invite` del actor para ese evento.
 */
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  availabilityFor,
  RSVP_RESPONSES,
  respondToEvent,
  type RsvpResponse,
} from "../../../../../../../lib/calendar/google-calendar-client";
import { inviteDedupeKey } from "../../../../../../../lib/notifications/producers/calendar-invites";
import { accessFailure, resolveAccessLevel } from "../../../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../../../utils/db-pool";
import { googleFailure } from "../../../_lib/target";

function eventIdOf(req: AuthenticatedMedusaRequest): string | null {
  const raw = String(req.params.eventId ?? "").trim();
  const id = raw.startsWith("gcal:") ? raw.slice(5) : raw;
  return /^[A-Za-z0-9_@.-]{5,1024}$/.test(id) ? id : null;
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  let actor: { userId: string; email: string };
  try {
    actor = await resolveAccessLevel(req);
  } catch (error) {
    accessFailure(res, error);
    return;
  }
  const eventId = eventIdOf(req);
  if (!eventId) {
    res.status(400).json({ error: "invalid event id" });
    return;
  }
  const response = (req.body as { response?: unknown } | undefined)?.response;
  if (typeof response !== "string" || !(RSVP_RESPONSES as readonly string[]).includes(response)) {
    res.status(400).json({ error: "response must be accepted, declined or tentative" });
    return;
  }
  const availability = availabilityFor(actor.email);
  if (availability !== "ok") {
    res.status(409).json({ error: "CALENDAR_UNAVAILABLE", availability });
    return;
  }
  try {
    const out = await respondToEvent(actor.email, eventId, response as RsvpResponse);
    const { rowCount } = await getDbPool().query(
      `UPDATE pos_notification SET resolved_at = NOW(), updated_at = NOW()
        WHERE dedupe_key = $1 AND resolved_at IS NULL`,
      [inviteDedupeKey(actor.userId, eventId)]
    );
    res.json({ ok: true, response: out.status ?? response, notification_resolved: (rowCount ?? 0) > 0 });
  } catch (error) {
    googleFailure(res, error, "Failed to respond to the invitation");
  }
}
