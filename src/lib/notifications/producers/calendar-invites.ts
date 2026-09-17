/**
 * Invitaciones de Google Calendar pendientes → el invitado, con Accept /
 * Decline / Maybe en el panel del POS (ruta rsvp).
 *
 * Desde `3b9c1e04` el calendario del POS es el PRINCIPAL del usuario (scope
 * `calendar.events.owned`), así que una invitación —de un coworker o de
 * afuera— cae ahí y se lee impersonando al invitado. El job recorre el staff
 * del dominio; fuera del dominio (gmail, buildblend) no hay DWD y se saltea.
 *
 * Dedupe `cal_invite:{userId}:{eventId}`; cuando la invitación deja de estar
 * `needsAction` (respondió desde Google, el organizador la canceló) el aviso se
 * resuelve. Sin `GMAIL_SERVICE_ACCOUNT_KEY` (sandbox) no se llama a Google.
 */

import {
  isDwdEligible,
  listPendingInvitations,
  type PendingInvitation,
} from "../../calendar/google-calendar-client";
import { getBusinessDateString } from "../../date/et";
import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

export const INVITE_HORIZON_DAYS = 60;

interface StaffRow {
  user_id: string;
  email: string;
}

export function inviteDedupeKey(userId: string, eventId: string): string {
  return `cal_invite:${userId}:${eventId}`;
}

function whenLabel(inv: PendingInvitation): string {
  if (inv.all_day) return `${inv.start} (all day)`;
  const d = new Date(inv.start);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function buildInviteNotification(userId: string, inv: PendingInvitation) {
  return {
    kind: "calendar_invite" as const,
    severity: "info" as const,
    title: `Invitation: ${inv.title || "(no title)"}`,
    body: `${whenLabel(inv)}${inv.organizer_email ? ` · from ${inv.organizer_email}` : ""}`,
    action_url: "/calendar",
    entity_type: "calendar_event",
    entity_id: inv.id,
    payload: { event_id: inv.id, organizer_email: inv.organizer_email, start: inv.start, all_day: inv.all_day },
    dedupe_key: inviteDedupeKey(userId, inv.id),
    occurred_at: new Date(),
    audiences: [{ kind: "users" as const, user_ids: [userId] }],
  };
}

/** Staff del dominio con usuario Medusa: a quién se le puede leer el principal. */
async function domainStaff(db: Db): Promise<StaffRow[]> {
  const { rows } = await db.query<StaffRow>(
    `SELECT DISTINCT u.id AS user_id, lower(u.email) AS email
       FROM "user" u
       JOIN pos_user p ON lower(p.email) = lower(u.email) AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL`
  );
  return rows.filter((r) => isDwdEligible(r.email) && !r.email.startsWith("webhook@"));
}

export async function produceCalendarInvites(
  db: Db,
  opts: { now?: Date; fetch?: (email: string, from: string, to: string) => Promise<PendingInvitation[]> } = {}
): Promise<{ users: number; pending: number; created: number; resolved: number; errors: number }> {
  // Sandbox: el dump trae los emails REALES del equipo y la SA de prod está en
  // .env — sin este guard, un `medusa exec` local lee los calendarios de prod.
  const sandboxBlocked = process.env.ECOPOWERTECH_ENV === "sandbox" && process.env.CALENDAR_INVITES_ALLOW_SANDBOX !== "1";
  if (!process.env.GMAIL_SERVICE_ACCOUNT_KEY || (sandboxBlocked && !opts.fetch)) {
    return { users: 0, pending: 0, created: 0, resolved: 0, errors: 0 };
  }
  const now = opts.now ?? new Date();
  const from = getBusinessDateString(now);
  const to = getBusinessDateString(new Date(now.getTime() + INVITE_HORIZON_DAYS * 86_400_000));
  const fetch = opts.fetch ?? listPendingInvitations;
  const staff = await domainStaff(db);
  let pending = 0, created = 0, resolved = 0, errors = 0;
  const results: PublishResult[] = [];
  for (const person of staff) {
    let invites: PendingInvitation[];
    try {
      invites = await fetch(person.email, from, to);
    } catch {
      errors += 1; // una cuenta sin DWD todavía no frena a las demás
      continue;
    }
    pending += invites.length;
    for (const inv of invites) {
      const r = await publishNotification(db, buildInviteNotification(person.user_id, inv));
      results.push(r);
      if (r.created) created += 1;
    }
    // Lo que ya no está pendiente se resuelve (respondió en Google / se canceló).
    const live = invites.map((i) => inviteDedupeKey(person.user_id, i.id));
    const { rowCount } = await db.query(
      `UPDATE pos_notification SET resolved_at = NOW(), updated_at = NOW()
        WHERE kind = 'calendar_invite' AND resolved_at IS NULL
          AND dedupe_key LIKE $1 AND NOT (dedupe_key = ANY($2::text[]))`,
      [`cal_invite:${person.user_id}:%`, live]
    );
    resolved += rowCount ?? 0;
  }
  return { users: staff.length, pending, created, resolved, errors };
}
