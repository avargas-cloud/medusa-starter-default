/**
 * src/lib/calendar/google-calendar-client.ts
 *
 * Acceso al Google Calendar del usuario del POS vía la Service Account con
 * Domain-Wide Delegation que ya usa `utils/gmail-sent-insert.ts` (misma clave,
 * `GMAIL_SERVICE_ACCOUNT_KEY`; mismo patrón `JWT + subject`).
 *
 * SEGURIDAD — las tres decisiones que hacen que "robar la clave" valga poco:
 *
 * 1. Scope ÚNICO `calendar.app.created`: la SA sólo puede crear calendarios
 *    secundarios y ver/editar eventos DE ESOS calendarios. No puede leer la
 *    agenda personal de nadie ni listar sus calendarios. Cambiar este scope es
 *    cambiar el contrato de privacidad con el equipo; `verify-calendars.ts` lo
 *    afirma y el smoke lo prueba con control negativo (`primary` → 403).
 * 2. El email a impersonar lo decide la RUTA a partir del JWT del usuario
 *    autenticado (o de un user_id que sólo el owner puede elegir). Este módulo
 *    no acepta emails del cliente ni hace fallback a ninguno.
 * 3. La clave nunca se loguea ni se devuelve; los errores se resumen.
 *
 * Sólo cuentas del dominio con DWD (`@ecopowertech.com`) son elegibles.
 */
import { auth as gauth, calendar as calendarClient, type calendar_v3 } from "@googleapis/calendar";

import type { CalendarAttendee, CalendarEvent } from "./calendar-events";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const DWD_DOMAIN = "ecopowertech.com";
export const POS_CALENDAR_SUMMARY = "EcoPowerTech POS";
export const BUSINESS_TZ = "America/New_York";

export type Availability = "ok" | "unavailable" | "not_configured";

export function isDwdEligible(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(`@${DWD_DOMAIN}`);
}

export function isCalendarConfigured(): boolean {
  return !!process.env.GMAIL_SERVICE_ACCOUNT_KEY;
}

export function availabilityFor(email: string | null | undefined): Availability {
  if (!isCalendarConfigured()) return "not_configured";
  return isDwdEligible(email) ? "ok" : "unavailable";
}

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function summarize(err: unknown): GoogleCalendarError {
  const e = err as { code?: number | string; response?: { status?: number }; message?: string };
  const status = Number(e.response?.status ?? e.code ?? 502);
  const message = typeof e.message === "string" ? e.message.slice(0, 200) : "Google Calendar request failed";
  return new GoogleCalendarError(message, Number.isFinite(status) && status >= 400 && status < 600 ? status : 502);
}

export function calendarFor(subjectEmail: string): calendar_v3.Calendar {
  const keyRaw = process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new GoogleCalendarError("Google service account not configured", 503);
  if (!isDwdEligible(subjectEmail)) throw new GoogleCalendarError("Account outside the company domain", 403);
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const authClient = new gauth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [CALENDAR_SCOPE],
    subject: subjectEmail,
  });
  return calendarClient({ version: "v3", auth: authClient });
}

/** Crea el calendario secundario del usuario. Devuelve su id (nunca `primary`). */
export async function createPosCalendar(subjectEmail: string): Promise<string> {
  try {
    const res = await calendarFor(subjectEmail).calendars.insert({
      requestBody: { summary: POS_CALENDAR_SUMMARY, timeZone: BUSINESS_TZ },
    });
    const id = res.data.id;
    if (!id) throw new GoogleCalendarError("Google did not return a calendar id", 502);
    return id;
  } catch (err) {
    throw err instanceof GoogleCalendarError ? err : summarize(err);
  }
}

/** ¿El calendario guardado sigue existiendo? (borrado a mano en Google → false). */
export async function calendarExists(subjectEmail: string, calendarId: string): Promise<boolean> {
  try {
    await calendarFor(subjectEmail).calendars.get({ calendarId });
    return true;
  } catch (err) {
    const s = summarize(err).status;
    if (s === 404 || s === 410) return false;
    throw summarize(err);
  }
}

export async function deletePosCalendar(subjectEmail: string, calendarId: string): Promise<void> {
  try {
    await calendarFor(subjectEmail).calendars.delete({ calendarId });
  } catch (err) {
    throw summarize(err);
  }
}

export interface PersonalEventInput {
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  description?: string | null;
  location?: string | null;
  /** Emails ya validados/normalizados por `parsePersonalEvent`. En PATCH reemplaza la lista. */
  attendees?: string[];
}

const ATTENDEE_STATUSES = new Set(["needsAction", "accepted", "declined", "tentative"]);

function toAttendees(list: calendar_v3.Schema$EventAttendee[] | undefined): CalendarAttendee[] | undefined {
  if (!list) return undefined;
  return list
    .filter((a) => !!a.email)
    .map((a) => ({
      email: String(a.email).toLowerCase(),
      name: a.displayName ?? null,
      status: a.responseStatus && ATTENDEE_STATUSES.has(a.responseStatus) ? (a.responseStatus as CalendarAttendee["status"]) : null,
      self: a.self === true,
    }));
}

function attendeesBody(input: PersonalEventInput): Pick<calendar_v3.Schema$Event, "attendees"> {
  // `attendees` ausente = no tocar; `[]` = quitar a todos (PATCH reemplaza la lista).
  return input.attendees === undefined ? {} : { attendees: input.attendees.map((email) => ({ email })) };
}

function toGoogleTimes(input: PersonalEventInput): Pick<calendar_v3.Schema$Event, "start" | "end"> {
  if (input.all_day) {
    // Google: `end.date` es EXCLUSIVO para all-day. La UI manda inclusivo.
    const endInclusive = input.end ?? input.start;
    const endExclusive = new Date(Date.parse(`${endInclusive}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    // `dateTime: null` explícito: `events.patch` MERGEA, y un evento que era con
    // hora conservaría su dateTime junto al date nuevo → Google: "Invalid start time".
    return { start: { date: input.start, dateTime: null }, end: { date: endExclusive, dateTime: null } };
  }
  const end = input.end ?? new Date(Date.parse(input.start) + 3_600_000).toISOString();
  // Simétrico: un all-day que pasa a tener hora tiene que soltar su `date`.
  return {
    start: { dateTime: input.start, timeZone: BUSINESS_TZ, date: null },
    end: { dateTime: end, timeZone: BUSINESS_TZ, date: null },
  };
}

export function toCalendarEvent(ev: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!ev.id || ev.status === "cancelled") return null;
  const allDay = !!ev.start?.date;
  const start = ev.start?.date ?? ev.start?.dateTime ?? null;
  if (!start) return null;
  let end: string | null = ev.end?.date ?? ev.end?.dateTime ?? null;
  if (allDay && end) {
    // De exclusivo (Google) a inclusivo (contrato del POS).
    end = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (end === start) end = null;
  }
  return {
    id: `gcal:${ev.id}`,
    source: "google_personal",
    title: ev.summary ?? "(untitled)",
    start,
    end,
    all_day: allDay,
    status: null,
    amount_cents: null,
    ref: ev.id,
    meta: {
      description: ev.description ?? null,
      location: ev.location ?? null,
      html_link: ev.htmlLink ?? null,
    },
    attendees: toAttendees(ev.attendees),
  };
}

export async function listEvents(
  subjectEmail: string,
  calendarId: string,
  fromDate: string,
  toDate: string
): Promise<CalendarEvent[]> {
  try {
    const res = await calendarFor(subjectEmail).events.list({
      calendarId,
      timeMin: `${fromDate}T00:00:00-05:00`,
      timeMax: `${toDate}T23:59:59-04:00`,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 500,
      timeZone: BUSINESS_TZ,
    });
    return (res.data.items ?? []).map(toCalendarEvent).filter((e): e is CalendarEvent => e !== null);
  } catch (err) {
    throw summarize(err);
  }
}

export async function insertEvent(subjectEmail: string, calendarId: string, input: PersonalEventInput): Promise<CalendarEvent> {
  try {
    // sendUpdates=all: Google manda la invitación a los guests desde la cuenta del
    // usuario (delta v3, pedido del owner). Sin guests no se envía nada.
    const res = await calendarFor(subjectEmail).events.insert({
      calendarId,
      sendUpdates: input.attendees?.length ? "all" : "none",
      requestBody: {
        summary: input.title,
        description: input.description ?? undefined,
        location: input.location ?? undefined,
        ...toGoogleTimes(input),
        ...attendeesBody(input),
      },
    });
    const ev = toCalendarEvent(res.data);
    if (!ev) throw new GoogleCalendarError("Google returned an unusable event", 502);
    return ev;
  } catch (err) {
    throw err instanceof GoogleCalendarError ? err : summarize(err);
  }
}

export async function updateEvent(
  subjectEmail: string,
  calendarId: string,
  eventId: string,
  input: PersonalEventInput
): Promise<CalendarEvent> {
  try {
    const res = await calendarFor(subjectEmail).events.patch({
      calendarId,
      eventId,
      sendUpdates: input.attendees === undefined ? "none" : "all",
      requestBody: {
        summary: input.title,
        description: input.description ?? "",
        location: input.location ?? "",
        ...toGoogleTimes(input),
        ...attendeesBody(input),
      },
    });
    const ev = toCalendarEvent(res.data);
    if (!ev) throw new GoogleCalendarError("Google returned an unusable event", 502);
    return ev;
  } catch (err) {
    throw err instanceof GoogleCalendarError ? err : summarize(err);
  }
}

export async function deleteEvent(subjectEmail: string, calendarId: string, eventId: string): Promise<void> {
  try {
    // Un evento con guests avisa la cancelación; Google no manda nada si no hay.
    await calendarFor(subjectEmail).events.delete({ calendarId, eventId, sendUpdates: "all" });
  } catch (err) {
    const s = summarize(err);
    if (s.status === 404 || s.status === 410) return; // ya no está: idempotente
    throw s;
  }
}

export type PrimaryProbe = "forbidden" | "readable" | "scope_not_authorized" | "error";

/**
 * Control negativo del smoke: con `calendar.app.created` leer `primary` DEBE
 * fallar con 403/404 (`forbidden`). `readable` = el scope habilitado en Admin
 * Console es más amplio de lo que este módulo promete → frenar. Un 401
 * `unauthorized_client` es otra cosa: el scope AÚN no está autorizado para la
 * SA en Admin Console (o no propagó) → `scope_not_authorized`.
 */
export async function probePrimary(subjectEmail: string): Promise<{ result: PrimaryProbe; detail: string }> {
  try {
    await calendarFor(subjectEmail).events.list({ calendarId: "primary", maxResults: 1 });
    return { result: "readable", detail: "events.list(primary) → 200" };
  } catch (err) {
    const s = summarize(err);
    if (s.status === 403 || s.status === 404) return { result: "forbidden", detail: `HTTP ${s.status}` };
    if (s.status === 401 || /unauthorized_client/.test(s.message)) return { result: "scope_not_authorized", detail: s.message };
    return { result: "error", detail: `HTTP ${s.status}: ${s.message}` };
  }
}
