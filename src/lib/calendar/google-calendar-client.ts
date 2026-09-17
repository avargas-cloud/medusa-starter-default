/**
 * src/lib/calendar/google-calendar-client.ts
 *
 * Acceso al Google Calendar del usuario del POS vía la Service Account con
 * Domain-Wide Delegation que ya usa `utils/gmail-sent-insert.ts` (misma clave,
 * `GMAIL_SERVICE_ACCOUNT_KEY`; mismo patrón `JWT + subject`).
 *
 * DECISIÓN 09/17/2026 (owner, opción B): el calendario del POS es el PRINCIPAL
 * del usuario, no un secundario. Con el secundario (`calendar.app.created`) las
 * invitaciones que un coworker aceptaba caían en su principal y el POS no las
 * veía. Scope: `calendar.events.owned` — eventos de los calendarios que el
 * usuario POSEE (su principal incluido); no lista calendarios ajenos ni
 * compartidos ni toca ACLs/settings.
 *
 * SEGURIDAD — lo que sigue valiendo y lo que cambió:
 * 1. La SA ahora PUEDE leer eventos del calendario principal de cualquier
 *    cuenta del dominio (igual que hoy puede insertar correos en cualquier
 *    buzón con gmail.insert). Quien limita es la RUTA: el email a impersonar
 *    sale del JWT del usuario autenticado; `user_id` ajeno sólo lo honra el
 *    owner. Este módulo no acepta emails del cliente ni hace fallback.
 * 2. La clave nunca se loguea ni se devuelve; los errores se resumen.
 * 3. Sólo cuentas del dominio con DWD (`@ecopowertech.com`) son elegibles.
 */
import { auth as gauth, calendar as calendarClient, type calendar_v3 } from "@googleapis/calendar";

import type { CalendarAttendee, CalendarEvent } from "./calendar-events";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
/** El calendario que el POS lee y escribe: el principal del usuario impersonado. */
export const PRIMARY_CALENDAR_ID = "primary";
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
      // Un evento al que el usuario fue INVITADO vive en su principal pero no es
      // suyo: Google rechaza editarlo/borrarlo; la pantalla lo muestra en modo lectura.
      is_organizer: !ev.organizer || ev.organizer.self === true,
      organizer_email: ev.organizer?.email ?? null,
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

export type ScopeProbe = "narrow" | "too_broad" | "scope_not_authorized" | "error";

/**
 * Control negativo del smoke con `calendar.events.owned`: leer el principal SÍ
 * debe funcionar; lo que NO debe funcionar es enumerar calendarios
 * (`calendarList.list` exige calendar.calendarlist / calendar). `too_broad` =
 * el scope autorizado en Admin Console es más amplio que el prometido. Un 401
 * `unauthorized_client` = el scope aún no está autorizado (o no propagó).
 */
export async function probeScope(subjectEmail: string): Promise<{ result: ScopeProbe; detail: string }> {
  try {
    await calendarFor(subjectEmail).events.list({ calendarId: PRIMARY_CALENDAR_ID, maxResults: 1 });
  } catch (err) {
    const s = summarize(err);
    if (s.status === 401 || /unauthorized_client/.test(s.message)) return { result: "scope_not_authorized", detail: s.message };
    return { result: "error", detail: `primary: HTTP ${s.status}: ${s.message}` };
  }
  try {
    await calendarFor(subjectEmail).calendarList.list({ maxResults: 1 });
    return { result: "too_broad", detail: "calendarList.list → 200" };
  } catch (err) {
    const s = summarize(err);
    if (s.status === 403 || s.status === 401) return { result: "narrow", detail: `primary legible; calendarList HTTP ${s.status}` };
    return { result: "error", detail: `calendarList: HTTP ${s.status}: ${s.message}` };
  }
}

// ─── Invitaciones + RSVP (pos-notifications-phase2-20260917) ─────────────────
//
// Con el principal como calendario del POS (scope calendar.events.owned), las
// invitaciones que recibe el usuario están en `primary` como eventos donde él
// es attendee con `self: true` y `responseStatus: needsAction`. Responder es un
// `events.patch` sobre SU copia con `attendeesOmitted: true` — PATCH reemplaza
// arrays, y sin ese flag mandar un solo attendee borraría a los demás — y
// `sendUpdates: none`: Google ya le avisa al organizador por su cuenta.

export type RsvpResponse = "accepted" | "declined" | "tentative";
export const RSVP_RESPONSES: readonly RsvpResponse[] = ["accepted", "declined", "tentative"];

export interface PendingInvitation {
  id: string;
  title: string;
  start: string;
  all_day: boolean;
  organizer_email: string | null;
}

/** Puro: de una lista de eventos del principal, los que esperan MI respuesta. */
export function pendingInvitationsOf(items: calendar_v3.Schema$Event[]): PendingInvitation[] {
  const out: PendingInvitation[] = [];
  for (const ev of items) {
    if (!ev.id || ev.status === "cancelled") continue;
    const me = (ev.attendees ?? []).find((a) => a.self === true);
    if (!me || me.responseStatus !== "needsAction") continue;
    if (ev.organizer?.self === true) continue;
    const start = ev.start?.date ?? ev.start?.dateTime ?? null;
    if (!start) continue;
    out.push({
      id: ev.id,
      title: ev.summary ?? "",
      start,
      all_day: !!ev.start?.date,
      organizer_email: ev.organizer?.email ? ev.organizer.email.toLowerCase() : null,
    });
  }
  return out;
}

export async function listPendingInvitations(
  subjectEmail: string,
  fromDate: string,
  toDate: string
): Promise<PendingInvitation[]> {
  try {
    const res = await calendarFor(subjectEmail).events.list({
      calendarId: PRIMARY_CALENDAR_ID,
      timeMin: `${fromDate}T00:00:00-05:00`,
      timeMax: `${toDate}T23:59:59-04:00`,
      singleEvents: true,
      showHiddenInvitations: true,
      maxResults: 500,
      timeZone: BUSINESS_TZ,
    });
    return pendingInvitationsOf(res.data.items ?? []);
  } catch (err) {
    throw summarize(err);
  }
}

/** El cuerpo exacto del PATCH — separado para poder afirmarlo sin Google. */
export function rsvpPatchBody(selfEmail: string, response: RsvpResponse): calendar_v3.Schema$Event {
  return { attendeesOmitted: true, attendees: [{ email: selfEmail, responseStatus: response }] };
}

export async function respondToEvent(
  subjectEmail: string,
  eventId: string,
  response: RsvpResponse
): Promise<{ status: RsvpResponse | null }> {
  try {
    const res = await calendarFor(subjectEmail).events.patch({
      calendarId: PRIMARY_CALENDAR_ID,
      eventId,
      sendUpdates: "none",
      requestBody: rsvpPatchBody(subjectEmail, response),
    });
    const me = (res.data.attendees ?? []).find((a) => a.self === true || a.email?.toLowerCase() === subjectEmail.toLowerCase());
    const status = me?.responseStatus && (RSVP_RESPONSES as readonly string[]).includes(me.responseStatus) ? (me.responseStatus as RsvpResponse) : null;
    return { status };
  } catch (err) {
    throw summarize(err);
  }
}
