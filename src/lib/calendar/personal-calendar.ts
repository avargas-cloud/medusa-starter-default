/**
 * src/lib/calendar/personal-calendar.ts
 *
 * Quién es el dueño del calendario que una request quiere ver, y cuál es su
 * calendario. Las dos reglas de autorización viven acá y en ningún otro lado:
 *
 * · El objetivo por defecto es el USUARIO AUTENTICADO (identidad resuelta del
 *   JWT por `resolveAccessLevel`). El cliente no manda emails.
 * · `user_id` explícito sólo lo honra un OWNER; a cualquier otro se le contesta
 *   403 aunque pida su propio id — así el parámetro nunca se vuelve un canal.
 *
 * El calendario "EcoPowerTech POS" se crea la primera vez que el usuario abre
 * la página (o cuando el que Google tenía ya no existe) y su id se recuerda en
 * `pos_user_calendar`.
 */
import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { PosAccessError, resolveAccessLevel } from "../pos/access-level";

import {
  availabilityFor,
  calendarExists,
  createPosCalendar,
  type Availability,
} from "./google-calendar-client";
import type { RawPg } from "./recurring-repo";

export interface CalendarUser {
  id: string;
  email: string;
  name: string;
}

export interface CalendarTarget {
  target: CalendarUser;
  availability: Availability;
  /** Sólo para el owner: el selector de usuarios. */
  users: CalendarUser[] | null;
  isOwner: boolean;
}

function rowToUser(r: Record<string, unknown>): CalendarUser {
  const first = r.first_name == null ? "" : String(r.first_name);
  const last = r.last_name == null ? "" : String(r.last_name);
  const name = `${first} ${last}`.trim() || String(r.email);
  return { id: String(r.id), email: String(r.email), name };
}

/** Los usuarios con acceso al POS (whitelist `pos_user` por email), vivos. */
export async function listPosUsers(pg: RawPg): Promise<CalendarUser[]> {
  const res = await pg.raw(
    `SELECT u.id, u.email, u.first_name, u.last_name
       FROM "user" u
       JOIN pos_user p ON lower(p.email) = lower(u.email) AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
      ORDER BY u.first_name, u.last_name, u.email`,
    []
  );
  return res.rows.map(rowToUser);
}

async function loadUser(pg: RawPg, userId: string): Promise<CalendarUser | null> {
  const res = await pg.raw(
    `SELECT id, email, first_name, last_name FROM "user" WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  return res.rows[0] ? rowToUser(res.rows[0]) : null;
}

export async function resolveCalendarTarget(
  req: AuthenticatedMedusaRequest,
  pg: RawPg,
  requestedUserId: string | null
): Promise<CalendarTarget> {
  const me = await resolveAccessLevel(req);
  let target: CalendarUser | null = null;
  if (requestedUserId && requestedUserId !== me.userId) {
    if (!me.isOwner) throw new PosAccessError("OWNER_REQUIRED", 403);
    target = await loadUser(pg, requestedUserId);
    if (!target) throw new PosAccessError("USER_NOT_FOUND", 404);
  } else {
    target = (await loadUser(pg, me.userId)) ?? { id: me.userId, email: me.email, name: me.email };
  }
  return {
    target,
    availability: availabilityFor(target.email),
    users: me.isOwner ? await listPosUsers(pg) : null,
    isOwner: me.isOwner,
  };
}

/**
 * Devuelve el id del calendario del usuario, creándolo si hace falta. Si el
 * email cambió respecto del guardado, o Google ya no tiene ese calendario, se
 * crea uno nuevo y se reemplaza la fila.
 */
export async function ensurePosCalendar(pg: RawPg, user: CalendarUser): Promise<string> {
  const res = await pg.raw(`SELECT email, google_calendar_id FROM pos_user_calendar WHERE user_id = ?`, [user.id]);
  const row = res.rows[0];
  if (row && String(row.email).toLowerCase() === user.email.toLowerCase()) {
    const id = String(row.google_calendar_id);
    if (await calendarExists(user.email, id)) return id;
  }
  const created = await createPosCalendar(user.email);
  await pg.raw(
    `INSERT INTO pos_user_calendar (user_id, email, google_calendar_id)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, google_calendar_id = EXCLUDED.google_calendar_id, updated_at = now()`,
    [user.id, user.email, created]
  );
  return created;
}

export interface ParsedPersonalEvent {
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  description: string | null;
  location: string | null;
  /** undefined = el cliente no mandó la clave (PATCH: no tocar la lista). */
  attendees?: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ATTENDEES = 50;

/** Emails válidos, en minúsculas, sin duplicados; `null` si alguno no es un email. */
export function parseAttendees(raw: unknown): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: "attendees must be an array of emails" };
  if (raw.length > MAX_ATTENDEES) return { ok: false, error: `at most ${MAX_ATTENDEES} attendees` };
  const out: string[] = [];
  for (const item of raw) {
    const email = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: `invalid attendee email: ${String(item).slice(0, 60)}` };
    if (!out.includes(email)) out.push(email);
  }
  return { ok: true, value: out };
}

export function parsePersonalEvent(raw: unknown): { ok: true; value: ParsedPersonalEvent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : "";
  if (!title) return { ok: false, error: "title is required" };
  const all_day = b.all_day === true;
  const start = typeof b.start === "string" ? b.start.trim() : "";
  const end = typeof b.end === "string" && b.end.trim() ? b.end.trim() : null;
  if (all_day) {
    if (!DATE_RE.test(start)) return { ok: false, error: "start must be YYYY-MM-DD for all-day events" };
    if (end !== null && !DATE_RE.test(end)) return { ok: false, error: "end must be YYYY-MM-DD for all-day events" };
    if (end !== null && end < start) return { ok: false, error: "end must not precede start" };
  } else {
    if (!Number.isFinite(Date.parse(start))) return { ok: false, error: "start must be an ISO date-time" };
    if (end !== null && !Number.isFinite(Date.parse(end))) return { ok: false, error: "end must be an ISO date-time" };
    if (end !== null && Date.parse(end) < Date.parse(start)) return { ok: false, error: "end must not precede start" };
  }
  const opt = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const attendees = parseAttendees(b.attendees);
  if (!attendees.ok) return attendees;
  return {
    ok: true,
    value: { title, start, end, all_day, description: opt(b.description, 2000), location: opt(b.location, 300), attendees: attendees.value },
  };
}
