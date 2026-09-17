/**
 * verify-calendars.ts — gate del plan pos-calendars-20260917.
 *
 *   env DATABASE_URL="<sandbox>" yarn tsx src/scripts/verify/verify-calendars.ts
 *
 * §1 Generador puro de recurrencias (sin DB): política de fin de mes en
 *    febrero, biweekly anclado, yearly, weekly con weekday, rango vacío, y el
 *    control NEGATIVO: `skip` en febrero NO produce ocurrencia.
 * §2 Validación de frontera: cuerpos inválidos se rechazan con mensaje.
 * §3 DB (si hay DATABASE_URL): las tablas existen con sus constraints;
 *    materializar dos veces inserta cero la segunda (idempotencia);
 *    `overdue` se deriva y no se persiste; editar una regla conserva la
 *    ocurrencia pagada y regenera sólo el futuro. Todo en una transacción con
 *    ROLLBACK — no deja rastro.
 * §4 Estático: las rutas de escritura de reglas llaman `requirePin`, y la
 *    de ocurrencias NO (decisión documentada), y `gmail-sent-insert.ts` no
 *    cambió de forma (el patrón se copia, no se toca).
 * §5 Google (estático + puro): el scope es ÚNICAMENTE calendar.events.owned; el
 *    cliente de Google no acepta un email que no sea del dominio; las rutas
 *    del calendario personal no leen emails del request; `user_id` sólo pasa
 *    por `resolveCalendarTarget`, que exige owner; el mapeo all-day
 *    inclusivo↔exclusivo de Google es simétrico.
 * §6 Documentos (calendar-workqueue-20260917, DB con ROLLBACK): el snapshot de
 *    la ocurrencia congela kind/payee/cuentas; una ocurrencia MOVIDA sobrevive
 *    a la re-materialización con su snapshot íntegro; enlace → `booked` con el
 *    monto real; doble enlace 409; reabrir una enlazada 409; desenlace sólo si
 *    sigue `booked` con ESE documento; los CHECKs y el índice único parcial
 *    muerden; el prefill bloquea un bill sin vendor y deriva `card_charge` de
 *    una tarjeta; y la CARRERA real: dos transacciones sobre la misma
 *    ocurrencia → una enlaza y la otra 409 (datos commiteados y borrados al
 *    final, porque dos conexiones no comparten un ROLLBACK).
 * §7 Estático: cada camino que crea o mata un documento llama al enlace /
 *    desenlace (fuera de imports); el feed lee `expected` y su Create & match
 *    enlaza DENTRO de la transacción del documento con la ocurrencia en el
 *    hash; idempotencia registrada; rutas nuevas declaradas en el guard de
 *    accounting; y la otra mitad del gate — las pantallas MANDAN el PIN de
 *    regla y el `recurring_occurrence_id` / `occurrence_id`.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import { generateOccurrences, viewStatus } from "../../lib/calendar/recurring-occurrences";
import { parseOccurrenceMove, parseOccurrencePatch, parseRecurringRule } from "../../lib/calendar/recurring-types";
import { CALENDAR_SCOPE, isDwdEligible, toCalendarEvent } from "../../lib/calendar/google-calendar-client";
import { parseAttendees, parsePersonalEvent } from "../../lib/calendar/personal-calendar";
import { payeeMatches } from "../../lib/calendar/feed-expected-hints";
import {
  OccurrenceError,
  linkOccurrence,
  lockLinkable,
  moveOccurrence,
  patchOccurrence,
  pgLinkDb,
  unlinkByDocument,
} from "../../lib/calendar/occurrence-link";
import { buildOccurrencePrefill } from "../../lib/calendar/occurrence-prefill";
import {
  createRule,
  deleteRule,
  getOccurrence,
  listOccurrences,
  materializeRule,
  rematerializeFuture,
  updateRule,
  type RawPg,
} from "../../lib/calendar/recurring-repo";

const ROOT = resolve(__dirname, "../../..");
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const base = {
  payee_type: null,
  payee_id: null,
  payee_name: null,
  expense_account_list_id: null,
  pay_from_account_list_id: null,
  expected_amount_cents: 150000,
  amount_kind: "fixed" as const,
  tolerance_cents: 0,
  tolerance_pct: 0,
  weekday: null,
  month_of_year: null,
  end_date: null,
  is_active: true,
  notes: null,
  document_kind: "expense" as const,
};

function section1(): void {
  console.log("\n§1 generador puro");
  const m31 = { ...base, name: "SaaS 31", frequency: "monthly" as const, day_of_month: 31, end_of_month_policy: "last_day" as const, start_date: "2026-01-01" };
  const lastDay = generateOccurrences(m31, "2026-01-01", "2026-04-30").map((o) => o.due_date);
  check("monthly 31 last_day → 31,28,31,30", lastDay.join() === "2026-01-31,2026-02-28,2026-03-31,2026-04-30", lastDay.join());

  const skip = generateOccurrences({ ...m31, end_of_month_policy: "skip" }, "2026-01-01", "2026-04-30").map((o) => o.due_date);
  // skip = "los meses sin día 31 no vencen": febrero Y abril quedan afuera.
  check("NEGATIVO: monthly 31 skip → febrero y abril ausentes", skip.join() === "2026-01-31,2026-03-31", skip.join());

  const nbd = generateOccurrences({ ...m31, end_of_month_policy: "next_business_day" }, "2026-01-01", "2026-04-30").map((o) => o.due_date);
  // 2026-03-01 es domingo → lunes 2026-03-02
  check("monthly 31 next_business_day → febrero cae 2026-03-02 (lunes)", nbd.includes("2026-03-02") && !nbd.some((d) => d.startsWith("2026-02")), nbd.join());
  const keys = generateOccurrences({ ...m31, end_of_month_policy: "next_business_day" }, "2026-01-01", "2026-04-30").map((o) => o.period_key);
  check("period_key nominal único por mes", new Set(keys).size === keys.length && keys.includes("2026-02-28"), keys.join());

  const startMid = generateOccurrences({ ...m31, day_of_month: 1, start_date: "2026-09-17" }, "2026-09-01", "2026-11-30").map((o) => o.due_date);
  check("NEGATIVO: start_date 09/17 no genera el 09/01 pasado", startMid.join() === "2026-10-01,2026-11-01", startMid.join());

  const bi = generateOccurrences({ ...base, name: "bi", frequency: "biweekly", day_of_month: null, end_of_month_policy: "last_day", start_date: "2026-01-02" }, "2026-01-01", "2026-02-15").map((o) => o.due_date);
  check("biweekly anclado a start_date cada 14 días", bi.join() === "2026-01-02,2026-01-16,2026-01-30,2026-02-13", bi.join());

  const wk = generateOccurrences({ ...base, name: "wk", frequency: "weekly", day_of_month: null, weekday: 5, end_of_month_policy: "last_day", start_date: "2026-09-01" }, "2026-09-01", "2026-09-30").map((o) => o.due_date);
  check("weekly viernes en septiembre 2026", wk.join() === "2026-09-04,2026-09-11,2026-09-18,2026-09-25", wk.join());

  const yr = generateOccurrences({ ...base, name: "seguro", frequency: "yearly", day_of_month: 15, month_of_year: 3, end_of_month_policy: "last_day", start_date: "2026-06-01" }, "2026-01-01", "2028-12-31").map((o) => o.due_date);
  check("yearly marzo 15 desde junio 2026 → 2027, 2028", yr.join() === "2027-03-15,2028-03-15", yr.join());

  const q = generateOccurrences({ ...base, name: "q", frequency: "quarterly", day_of_month: 10, end_of_month_policy: "last_day", start_date: "2026-01-01" }, "2026-01-01", "2026-12-31").map((o) => o.due_date);
  check("quarterly día 10 → ene/abr/jul/oct", q.join() === "2026-01-10,2026-04-10,2026-07-10,2026-10-10", q.join());

  const ended = generateOccurrences({ ...m31, end_date: "2026-02-15" }, "2026-01-01", "2026-12-31").map((o) => o.due_date);
  check("end_date corta la serie", ended.join() === "2026-01-31", ended.join());
  check("rango vacío → []", generateOccurrences(m31, "2026-05-01", "2026-04-01").length === 0);

  check("viewStatus: expected + pasado = overdue", viewStatus("expected", "2026-09-01", "2026-09-17") === "overdue");
  check("viewStatus: paid + pasado sigue paid", viewStatus("paid", "2026-09-01", "2026-09-17") === "paid");
  check("viewStatus: expected + futuro sigue expected", viewStatus("expected", "2026-09-30", "2026-09-17") === "expected");
  check("viewStatus: booked + documento settled → paid (derivado)", viewStatus("booked", "2026-09-01", "2026-09-17", true) === "paid");
  check("viewStatus: booked sin settle sigue booked (aunque esté vencida)", viewStatus("booked", "2026-09-01", "2026-09-17", false) === "booked");
}

function section2(): void {
  console.log("\n§2 validación de frontera");
  const ok = parseRecurringRule({ name: "Rent", frequency: "monthly", day_of_month: 1, expected_amount_cents: 250000, start_date: "2026-01-01" });
  check("regla mínima válida", ok.ok);
  check("NEGATIVO: day_of_month 45 se rechaza (no se recorta)", !parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 45, expected_amount_cents: 1, start_date: "2026-01-01" }).ok);
  check("NEGATIVO: monto 0 se rechaza", !parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 0, start_date: "2026-01-01" }).ok);
  check("NEGATIVO: monto decimal se rechaza", !parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 10.5, start_date: "2026-01-01" }).ok);
  check("NEGATIVO: weekly sin weekday se rechaza", !parseRecurringRule({ name: "x", frequency: "weekly", expected_amount_cents: 1, start_date: "2026-01-01" }).ok);
  check("NEGATIVO: yearly sin month_of_year se rechaza", !parseRecurringRule({ name: "x", frequency: "yearly", day_of_month: 1, expected_amount_cents: 1, start_date: "2026-01-01" }).ok);
  check("NEGATIVO: end_date < start_date se rechaza", !parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 1, start_date: "2026-05-01", end_date: "2026-01-01" }).ok);
  check("NEGATIVO: frecuencia inventada se rechaza", !parseRecurringRule({ name: "x", frequency: "hourly", expected_amount_cents: 1, start_date: "2026-01-01" }).ok);
  const p = parseOccurrencePatch({ status: "skipped", actual_amount_cents: 5 });
  check("patch skipped descarta actual_amount", p.ok && p.value.actual_amount_cents === null);
  check("NEGATIVO: patch con status inventado se rechaza", !parseOccurrencePatch({ status: "done" }).ok);
  check("NEGATIVO: patch a 'booked' se rechaza (lo pone el documento, no el contador)", !parseOccurrencePatch({ status: "booked" }).ok);
  check("NEGATIVO: bill sin vendor se rechaza en la frontera", !parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 1, start_date: "2026-01-01", document_kind: "bill", payee_type: "other", payee_name: "Landlord" }).ok);
  const billOk = parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 1, start_date: "2026-01-01", document_kind: "bill", payee_type: "vendor", payee_id: "qbvnd_x", payee_name: "V" });
  check("bill con vendor pasa y conserva document_kind", billOk.ok && billOk.value.document_kind === "bill");
  check("document_kind ausente → expense", (() => { const r = parseRecurringRule({ name: "x", frequency: "monthly", day_of_month: 1, expected_amount_cents: 1, start_date: "2026-01-01" }); return r.ok && r.value.document_kind === "expense"; })());
  check("move: due_date válida", parseOccurrenceMove({ due_date: "2026-10-05" }).ok);
  check("NEGATIVO: move con fecha inventada se rechaza", !parseOccurrenceMove({ due_date: "next tuesday" }).ok);
  check("payeeMatches: 'Landlord LLC' ↔ 'LANDLORD PROPERTIES 0912'", payeeMatches("Landlord LLC", "LANDLORD PROPERTIES 0912", null));
  check("NEGATIVO: payeeMatches con sólo stop-words no matchea", !payeeMatches("The Co", "THE CO PAYMENT", null));
}

function rawAdapter(client: Client): RawPg {
  return {
    raw: async (sql, bindings = []) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(converted, bindings as unknown[]);
      return { rows: r.rows as Record<string, unknown>[] };
    },
  };
}

async function section3(): Promise<void> {
  console.log("\n§3 base de datos (transacción con ROLLBACK)");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("⏭️  sin DATABASE_URL — se omite");
    return;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  const pg = rawAdapter(client);
  try {
    await client.query("BEGIN");
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('recurring_expense_rule','recurring_expense_occurrence')`
    );
    check("tablas migradas", tables.rowCount === 2);
    const uq = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_rexo_rule_period'`);
    check("UNIQUE (rule_id, period_key) existe", uq.rowCount === 1);

    const input = parseRecurringRule({ name: "VERIFY rent", frequency: "monthly", day_of_month: 31, end_of_month_policy: "last_day", expected_amount_cents: 100000, start_date: "2026-01-01" });
    if (!input.ok) throw new Error(input.error);
    const rule = await createRule(pg, input.value, "verify");
    const first = await materializeRule(pg, rule, "2026-01-01", "2026-04-30");
    const second = await materializeRule(pg, rule, "2026-01-01", "2026-04-30");
    check("materializar inserta 4 y la segunda vez 0 (idempotente)", first === 4 && second === 0, `${first}/${second}`);

    const occs = await listOccurrences(pg, "2026-01-01", "2026-04-30");
    const mine = occs.filter((o) => o.rule_id === rule.id);
    check("febrero cae el 28 en DB", mine.some((o) => o.due_date === "2026-02-28"));
    const stored = await client.query(`SELECT DISTINCT status FROM recurring_expense_occurrence WHERE rule_id = $1`, [rule.id]);
    check("NEGATIVO: 'overdue' no se persiste (sólo expected)", stored.rows.length === 1 && stored.rows[0].status === "expected");

    const jan = mine.find((o) => o.due_date === "2026-01-31");
    if (!jan) throw new Error("no jan");
    const paid = await patchOccurrence(pg, jan.id, { status: "paid", actual_amount_cents: 99000, actual_date: "2026-01-30", note: null }, "verify");
    check("marcar pagada guarda actual", paid?.status === "paid" && paid.actual_amount_cents === 99000);

    const edited = await updateRule(pg, rule.id, { ...input.value, expected_amount_cents: 120000 }, "verify");
    if (!edited) throw new Error("no edited");
    await rematerializeFuture(pg, edited, "2026-03-01");
    const after = (await listOccurrences(pg, "2026-01-01", "2026-06-30")).filter((o) => o.rule_id === rule.id);
    const janAfter = after.find((o) => o.due_date === "2026-01-31");
    const febAfter = after.find((o) => o.due_date === "2026-02-28");
    const marAfter = after.find((o) => o.due_date === "2026-03-31");
    check("editar conserva la pagada (snapshot 1000.00 + paid)", janAfter?.status === "paid" && janAfter.expected_amount_cents === 100000);
    check("editar conserva el pasado no resuelto (febrero 1000.00)", febAfter?.expected_amount_cents === 100000);
    check("editar regenera el futuro con el snapshot nuevo (marzo 1200.00)", marAfter?.expected_amount_cents === 120000);

    const badDom = await client.query(`SAVEPOINT s1`).then(() =>
      client.query(`UPDATE recurring_expense_rule SET day_of_month = 45 WHERE id = $1`, [rule.id]).then(() => false).catch(() => true)
    );
    await client.query(`ROLLBACK TO SAVEPOINT s1`);
    check("NEGATIVO: CHECK rex_dom rechaza day_of_month 45", badDom);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

function stripImports(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*[{},\w\s]*\} from /.test(l))
    .join("\n");
}

function section4(): void {
  console.log("\n§4 estático");
  const dir = resolve(ROOT, "src/api/admin/accounting/recurring-expenses");
  const rules = stripImports(readFileSync(resolve(dir, "route.ts"), "utf8"));
  const ruleId = stripImports(readFileSync(resolve(dir, "[id]/route.ts"), "utf8"));
  const occ = stripImports(readFileSync(resolve(dir, "occurrences/[id]/route.ts"), "utf8"));
  check("POST de reglas llama requirePin (fuera de imports)", /requirePin\(/.test(rules));
  check("PATCH/DELETE de reglas llaman requirePin ×2", (ruleId.match(/requirePin\(/g) ?? []).length === 2);
  check("NEGATIVO: PATCH de ocurrencia NO pide PIN (decisión documentada)", !/requirePin\(/.test(occ) && /requireAccounting\(/.test(occ));
  const gmail = readFileSync(resolve(ROOT, "src/utils/gmail-sent-insert.ts"), "utf8");
  const gmailScopes = stripImports(gmail).match(/scopes:\s*\[([^\]]*)\]/)?.[1] ?? "";
  check("gmail-sent-insert.ts intacto (scopes: sólo gmail.insert)", gmailScopes.includes("gmail.insert") && !/calendar/.test(gmailScopes));
  const migration = readFileSync(resolve(ROOT, "src/migrations/Migration20260917100000-RecurringExpenses.ts"), "utf8");
  check("NEGATIVO: la migración no tiene FK a vendor_bill ni gl_*", !/REFERENCES\s+(vendor_bill|gl_)/.test(migration));
}

function section5(): void {
  console.log("\n§5 Google Calendar (estático + puro)");
  check("scope es exactamente calendar.events.owned (principal del usuario; sin listar calendarios ni ACLs)", CALENDAR_SCOPE === "https://www.googleapis.com/auth/calendar.events.owned");
  const client = readFileSync(resolve(ROOT, "src/lib/calendar/google-calendar-client.ts"), "utf8");
  const scopes = client.match(/scopes:\s*\[([^\]]*)\]/)?.[1] ?? "";
  check("NEGATIVO: el JWT no pide ningún otro scope de calendar", scopes.trim() === "CALENDAR_SCOPE");
  check("isDwdEligible: sólo @ecopowertech.com", isDwdEligible("x@ecopowertech.com") && !isDwdEligible("x@gmail.com") && !isDwdEligible("x@ecopowertech.com.evil.io"));
  const routesDir = resolve(ROOT, "src/api/admin/pos/calendar");
  const routeSrc = [
    readFileSync(resolve(routesDir, "events/route.ts"), "utf8"),
    readFileSync(resolve(routesDir, "events/[eventId]/route.ts"), "utf8"),
    readFileSync(resolve(routesDir, "_lib/target.ts"), "utf8"),
  ].join("\n");
  check("NEGATIVO: las rutas no leen un email del request", !/(query|body)\s*(as[^)]*\))?\s*\.\s*email|\bemail\s*=\s*String\(/.test(stripImports(routeSrc)));
  check("las rutas resuelven el objetivo sólo por resolveCalendarTarget", /resolveCalendarTarget\(/.test(stripImports(routeSrc)) && !/resolveAccessLevel\(/.test(stripImports(routeSrc)));
  const personal = stripImports(readFileSync(resolve(ROOT, "src/lib/calendar/personal-calendar.ts"), "utf8"));
  check("user_id ajeno exige isOwner (403 OWNER_REQUIRED)", /if \(!me\.isOwner\) throw new PosAccessError\("OWNER_REQUIRED", 403\)/.test(personal));
  const roundTrip = toCalendarEvent({ id: "abc", summary: "x", start: { date: "2026-09-17" }, end: { date: "2026-09-19" } });
  check("all-day: end exclusivo de Google → inclusivo del POS (09/19 → 09/18)", roundTrip?.end === "2026-09-18" && roundTrip.all_day);
  const single = toCalendarEvent({ id: "abc", summary: "x", start: { date: "2026-09-17" }, end: { date: "2026-09-18" } });
  check("all-day de un día → end null", single?.end === null);
  check("NEGATIVO: evento cancelado se descarta", toCalendarEvent({ id: "z", status: "cancelled", start: { date: "2026-09-17" } }) === null);
  check("parsePersonalEvent: all-day con hora se rechaza", !parsePersonalEvent({ title: "t", all_day: true, start: "2026-09-17T10:00:00Z" }).ok);
  check("parsePersonalEvent: end < start se rechaza", !parsePersonalEvent({ title: "t", all_day: false, start: "2026-09-17T10:00:00Z", end: "2026-09-17T09:00:00Z" }).ok);
  check("NEGATIVO: título vacío se rechaza", !parsePersonalEvent({ title: "  ", all_day: true, start: "2026-09-17" }).ok);
  const att = parseAttendees(["A@X.com", "a@x.com", "b@y.org"]);
  check("attendees: minúsculas + dedup", att.ok && att.value?.join() === "a@x.com,b@y.org");
  check("NEGATIVO: attendee sin @ se rechaza", !parseAttendees(["nope"]).ok);
  check("attendees ausente → undefined (PATCH no toca la lista)", parseAttendees(undefined).ok && parseAttendees(undefined).value === undefined);
  const withGuests = toCalendarEvent({ id: "g", summary: "x", start: { date: "2026-09-17" }, end: { date: "2026-09-18" }, attendees: [{ email: "P@z.com", responseStatus: "accepted", self: false }, { email: "", responseStatus: "declined" }] });
  check("attendees de Google → contrato (email en minúsculas, sin vacíos)", withGuests?.attendees?.length === 1 && withGuests.attendees[0].email === "p@z.com" && withGuests.attendees[0].status === "accepted");
  const client2 = readFileSync(resolve(ROOT, "src/lib/calendar/google-calendar-client.ts"), "utf8");
  check("patch anula el campo contrario (date:null / dateTime:null) — Google 'Invalid start time'", /dateTime: null/.test(client2) && /date: null/.test(client2));
  const mig = readFileSync(resolve(ROOT, "src/migrations/Migration20260917110000-PosUserCalendar.ts"), "utf8");
  check("pos_user_calendar guarda sólo ids (ni tokens ni claves)", /google_calendar_id/.test(mig) && !/token|secret|private_key/i.test(mig));
  const invited = toCalendarEvent({ id: "i", summary: "x", start: { date: "2026-09-17" }, end: { date: "2026-09-18" }, organizer: { email: "boss@ecopowertech.com", self: false } });
  check("evento al que fui invitado → is_organizer false (modo lectura)", invited?.meta.is_organizer === false && invited.meta.organizer_email === "boss@ecopowertech.com");
  const own = toCalendarEvent({ id: "o", summary: "x", start: { date: "2026-09-17" }, end: { date: "2026-09-18" }, organizer: { email: "me@ecopowertech.com", self: true } });
  check("evento propio → is_organizer true", own?.meta.is_organizer === true);
}

/** Cuentas y vendor REALES del sandbox: el prefill se prueba contra `qb_account`/`qb_vendor` vivos. */
async function sampleAccounts(client: Client) {
  const pick = async (type: string) =>
    (await client.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE account_type = $1 AND is_active AND deleted_at IS NULL ORDER BY full_name LIMIT 1`, [type])).rows[0]?.qb_list_id ?? null;
  const vendor = (await client.query<{ id: string }>(`SELECT id FROM qb_vendor WHERE is_active = true AND deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0]?.id ?? null;
  return { bank: await pick("Bank"), card: await pick("CreditCard"), expense: await pick("Expense"), vendor };
}

async function section6(): Promise<void> {
  console.log("\n§6 documentos (transacción con ROLLBACK + carrera commiteada)");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("⏭️  sin DATABASE_URL — se omite");
    return;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  const pg = rawAdapter(client);
  const link = pgLinkDb(client as unknown as import("pg").PoolClient);
  const acc = await sampleAccounts(client);
  check("el sandbox tiene Bank + CreditCard + Expense + vendor para probar", !!(acc.bank && acc.card && acc.expense && acc.vendor), JSON.stringify(acc));
  try {
    await client.query("BEGIN");
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'recurring_expense_occurrence'
         AND column_name IN ('document_kind','payee_type','payee_id','payee_name','expense_account_list_id','pay_from_account_list_id','due_date_override')`
    );
    check("migración: 7 columnas de snapshot/override en la ocurrencia", cols.rowCount === 7);
    const cons = await client.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('rexo_matched_pair','rexo_booked_linked','rexo_matched_kind','rex_document_kind')`
    );
    check("migración: CHECKs de enlace + document_kind", cons.rowCount === 4, cons.rows.map((r) => r.conname).join());
    const idx = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_rexo_matched_document'`);
    check("migración: índice único parcial (matched_kind, matched_id)", idx.rowCount === 1);

    const input = parseRecurringRule({
      name: "VERIFY expense", frequency: "monthly", day_of_month: 5, expected_amount_cents: 42000, start_date: "2026-01-01",
      document_kind: "expense", payee_type: "vendor", payee_id: acc.vendor, payee_name: "Verify Payee LLC",
      expense_account_list_id: acc.expense, pay_from_account_list_id: acc.bank,
    });
    if (!input.ok) throw new Error(input.error);
    const rule = await createRule(pg, input.value, "verify");
    await materializeRule(pg, rule, "2026-01-01", "2026-04-30");
    const occs = (await listOccurrences(pg, "2026-01-01", "2026-04-30")).filter((o) => o.rule_id === rule.id);
    const jan = occs.find((o) => o.due_date === "2026-01-05")!;
    const mar = occs.find((o) => o.due_date === "2026-03-05")!;
    check("snapshot: la ocurrencia congela kind/payee/cuentas de la regla",
      jan.document_kind === "expense" && jan.payee_id === acc.vendor && jan.payee_name === "Verify Payee LLC" &&
      jan.expense_account_list_id === acc.expense && jan.pay_from_account_list_id === acc.bank && !jan.due_date_override);

    // Mover UNA ocurrencia y editar la regla: la movida sobrevive con su snapshot viejo.
    const moved = await moveOccurrence(pg, mar.id, "2026-03-09", "verify");
    check("move: due_date nueva + override, period_key intacto", moved?.due_date === "2026-03-09" && moved.due_date_override && moved.period_key === mar.period_key);
    const edited = await updateRule(pg, rule.id, { ...input.value, expected_amount_cents: 50000, payee_name: "Renamed LLC" }, "verify");
    await rematerializeFuture(pg, edited!, "2026-02-01");
    const after = (await listOccurrences(pg, "2026-01-01", "2026-04-30")).filter((o) => o.rule_id === rule.id);
    const marAfter = after.find((o) => o.id === mar.id);
    const aprAfter = after.find((o) => o.due_date === "2026-04-05");
    check("override sobrevive a la re-materialización (mismo id, 03/09, snapshot 420.00 y payee viejo)",
      marAfter?.due_date === "2026-03-09" && marAfter.expected_amount_cents === 42000 && marAfter.payee_name === "Verify Payee LLC");
    check("la no movida se regeneró con el snapshot nuevo (500.00, Renamed LLC)", aprAfter?.expected_amount_cents === 50000 && aprAfter.payee_name === "Renamed LLC");
    check("NEGATIVO: no hay duplicado del período movido", after.filter((o) => o.period_key === mar.period_key).length === 1);

    // Enlace.
    const locked = await lockLinkable(link, jan.id);
    check("lockLinkable devuelve la ocurrencia expected", locked.id === jan.id);
    await linkOccurrence(link, jan.id, { kind: "gl_check", documentId: "gchk_verify_1", totalCents: 41950, day: "2026-01-04", actorId: "verify" });
    const booked = await getOccurrence(pg, jan.id);
    check("link: expected → booked con monto y fecha reales", booked?.status === "booked" && booked.matched_kind === "gl_check" && booked.matched_id === "gchk_verify_1" && booked.actual_amount_cents === 41950 && booked.actual_date === "2026-01-04");
    const dbl = await lockLinkable(link, jan.id).then(() => null).catch((e) => (e instanceof OccurrenceError ? e.code : "other"));
    check("NEGATIVO: doble enlace → OCCURRENCE_NOT_LINKABLE", dbl === "OCCURRENCE_NOT_LINKABLE");
    const reopen = await patchOccurrence(pg, jan.id, { status: "expected", actual_amount_cents: null, actual_date: null, note: null }, "verify").then(() => null).catch((e) => (e instanceof OccurrenceError ? e.code : "other"));
    check("NEGATIVO: reabrir una enlazada a mano → OCCURRENCE_LINKED", reopen === "OCCURRENCE_LINKED");
    const skip = await patchOccurrence(pg, jan.id, { status: "skipped", actual_amount_cents: null, actual_date: null, note: null }, "verify").then(() => null).catch((e) => (e instanceof OccurrenceError ? e.code : "other"));
    check("NEGATIVO: saltar una enlazada → OCCURRENCE_LINKED", skip === "OCCURRENCE_LINKED");
    const notMovable = await moveOccurrence(pg, jan.id, "2026-01-20", "verify").then(() => null).catch((e) => (e instanceof OccurrenceError ? e.code : "other"));
    check("NEGATIVO: mover una booked → OCCURRENCE_NOT_MOVABLE", notMovable === "OCCURRENCE_NOT_MOVABLE");
    check("NEGATIVO: desenlazar con OTRO documento no toca nada", (await unlinkByDocument(link, "gl_check", "gchk_other", "x")) === 0);
    check("desenlace: el documento muere → expected sin matched_* y con la razón en la nota",
      (await unlinkByDocument(link, "gl_check", "gchk_verify_1", "CHK-0001 voided")) === 1 &&
        (await getOccurrence(pg, jan.id).then((o) => o?.status === "expected" && o.matched_id === null && o.actual_amount_cents === null && /CHK-0001 voided/.test(o.note ?? ""))));
    check("NEGATIVO: segundo desenlace → 0", (await unlinkByDocument(link, "gl_check", "gchk_verify_1", "again")) === 0);
    // Marcar paid a mano una booked conserva el enlace; y después el desenlace NO la reabre.
    await linkOccurrence(link, jan.id, { kind: "vendor_bill", documentId: "vb_verify_1", totalCents: 42000, day: "2026-01-05", actorId: "verify" });
    const paidLinked = await patchOccurrence(pg, jan.id, { status: "paid", actual_amount_cents: 42000, actual_date: "2026-01-05", note: null }, "verify");
    check("paid a mano sobre una booked conserva matched_*", paidLinked?.status === "paid" && paidLinked.matched_id === "vb_verify_1");
    check("NEGATIVO: el desenlace no reabre una marcada paid (sólo booked)", (await unlinkByDocument(link, "vendor_bill", "vb_verify_1", "deleted")) === 0);

    // Constraints — sobre una fila que EXISTE: la re-materialización de arriba
    // regeneró febrero con otro id (un UPDATE sobre el id viejo afecta 0 filas y
    // "pasa" sin probar nada — el fixture es la cobertura).
    const feb = after.find((o) => o.due_date === "2026-02-05")!;
    check("fixture: febrero regenerado existe y está expected", !!feb && feb.status === "expected" && (await getOccurrence(pg, feb.id)) !== null);
    const tryUpdate = async (sql: string, params: unknown[]) => {
      await client.query("SAVEPOINT c");
      const failed = await client.query(sql, params).then(() => false).catch(() => true);
      await client.query("ROLLBACK TO SAVEPOINT c");
      return failed;
    };
    check("NEGATIVO: CHECK rexo_booked_linked — booked sin matched se rechaza",
      await tryUpdate(`UPDATE recurring_expense_occurrence SET status = 'booked' WHERE id = $1`, [feb.id]));
    check("NEGATIVO: CHECK rexo_matched_pair — matched_kind sin id se rechaza",
      await tryUpdate(`UPDATE recurring_expense_occurrence SET matched_kind = 'gl_check' WHERE id = $1`, [feb.id]));
    check("NEGATIVO: CHECK rexo_matched_kind — kind inventado se rechaza",
      await tryUpdate(`UPDATE recurring_expense_occurrence SET matched_kind = 'invoice', matched_id = 'x' WHERE id = $1`, [feb.id]));
    check("NEGATIVO: índice único — un documento no liquida dos ocurrencias",
      await tryUpdate(`UPDATE recurring_expense_occurrence SET status = 'booked', matched_kind = 'vendor_bill', matched_id = 'vb_verify_1' WHERE id = $1`, [feb.id]));
    check("NEGATIVO: CHECK rex_document_kind — kind inventado en la regla se rechaza",
      await tryUpdate(`UPDATE recurring_expense_rule SET document_kind = 'invoice' WHERE id = $1`, [rule.id]));

    // Prefill.
    const p1 = await buildOccurrencePrefill(feb, rule, client);
    // `feb` es la regenerada: lleva el snapshot NUEVO (Renamed LLC, 500.00).
    check("prefill expense desde Bank: check_kind expense, payee/cuentas/memo del SNAPSHOT", p1.blocked === null && p1.check_kind === "expense" && p1.payee?.name === "Renamed LLC" && p1.pay_from_account?.list_id === acc.bank && /VERIFY expense — 2026-02/.test(p1.memo) && p1.amount_cents === 50000 && p1.day === "2026-02-05", JSON.stringify({ blocked: p1.blocked, kind: p1.check_kind, payee: p1.payee?.name, memo: p1.memo, amount: p1.amount_cents }));
    const p2 = await buildOccurrencePrefill({ ...feb, pay_from_account_list_id: acc.card }, rule, client);
    check("prefill desde CreditCard → card_charge (la cuenta decide)", p2.blocked === null && p2.check_kind === "card_charge");
    const p3 = await buildOccurrencePrefill({ ...feb, document_kind: "bill", payee_type: "other", payee_id: null }, rule, client);
    check("NEGATIVO: prefill bill sin vendor → blocked", /vendor/i.test(p3.blocked ?? ""));
    const p4 = await buildOccurrencePrefill({ ...feb, document_kind: "bill" }, rule, client);
    check("prefill bill con vendor: vendor resuelto, sin check_kind", p4.blocked === null && p4.vendor?.id === acc.vendor && p4.check_kind === null);
    const p5 = await buildOccurrencePrefill({ ...feb, pay_from_account_list_id: null }, rule, client);
    check("NEGATIVO: prefill expense sin banco → blocked", /bank/i.test(p5.blocked ?? ""));
    const p6 = await buildOccurrencePrefill({ ...feb, pay_from_account_list_id: acc.expense }, rule, client);
    check("NEGATIVO: prefill expense pagando desde una cuenta de gasto → blocked", /not a bank/i.test(p6.blocked ?? ""));
  } finally {
    await client.query("ROLLBACK");
  }

  // Carrera: dos conexiones, la misma ocurrencia. Datos commiteados y borrados al final.
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  let raceRuleId: string | null = null;
  try {
    const input = parseRecurringRule({ name: "VERIFY race", frequency: "monthly", day_of_month: 1, expected_amount_cents: 1000, start_date: "2026-01-01", document_kind: "check", payee_type: "other", payee_name: "Race", expense_account_list_id: acc.expense, pay_from_account_list_id: acc.bank });
    if (!input.ok) throw new Error(input.error);
    const rule = await createRule(pg, input.value, "verify");
    raceRuleId = rule.id;
    await materializeRule(pg, rule, "2026-01-01", "2026-01-31");
    const occ = (await listOccurrences(pg, "2026-01-01", "2026-01-31")).find((o) => o.rule_id === rule.id)!;
    const la = pgLinkDb(a as unknown as import("pg").PoolClient);
    const lb = pgLinkDb(b as unknown as import("pg").PoolClient);
    await a.query("BEGIN");
    await b.query("BEGIN");
    await lockLinkable(la, occ.id);
    // B se queda esperando el FOR UPDATE hasta que A commitee.
    const bPromise = lockLinkable(lb, occ.id).then(() => "linkable" as const).catch((e) => (e instanceof OccurrenceError ? e.code : "other"));
    await new Promise((r) => setTimeout(r, 150));
    await linkOccurrence(la, occ.id, { kind: "gl_check", documentId: "gchk_race_a", totalCents: 1000, day: "2026-01-01", actorId: "a" });
    await a.query("COMMIT");
    const bResult = await bPromise;
    await b.query("ROLLBACK");
    const final = await getOccurrence(pg, occ.id);
    check("CARRERA: A enlaza y commitea; B, que esperaba el lock, ve booked → OCCURRENCE_NOT_LINKABLE", bResult === "OCCURRENCE_NOT_LINKABLE" && final?.matched_id === "gchk_race_a");
  } finally {
    if (raceRuleId) await deleteRule(pg, raceRuleId);
    await a.end();
    await b.end();
    await client.end();
  }
}

function section7(): void {
  console.log("\n§7 estático — documentos y feed");
  const read = (rel: string) => stripImports(readFileSync(resolve(ROOT, rel), "utf8"));
  const checks = read("src/api/admin/accounting/checks/route.ts");
  check("POST /accounting/checks: lockLinkable + linkOccurrence (fuera de imports)", /lockLinkable\(/.test(checks) && /linkOccurrence\(/.test(checks));
  check("POST /accounting/checks: el enlace va DENTRO de la tx del documento (hook inTransaction)", /inTransaction:/.test(checks));
  check("void de check llama unlinkByDocument", /unlinkByDocument\(/.test(read("src/api/admin/accounting/checks/[id]/void/route.ts")));
  const bankCheck = read("src/lib/ledger/documents/bank-check.ts");
  check("createBankCheck/voidBankCheck ejecutan el hook dentro de runInPostingTransaction", (bankCheck.match(/if \(hooks\.inTransaction\) await hooks\.inTransaction\(client, id\);/g) ?? []).length === 2);
  const vb = read("src/api/admin/vendor-bills/route.ts");
  check("POST /vendor-bills: lockLinkable antes del INSERT y linkOccurrence antes del commit", vb.indexOf("lockLinkable(") < vb.indexOf("INSERT INTO vendor_bill") && vb.indexOf("linkOccurrence(") < vb.indexOf("trx.commit()"));
  check("POST /vendor-bills: recurring_occurrence_id exige nivel accounting", /if \(occurrenceId\)[\s\S]{0,120}assertAccounting\(req\)/.test(vb));
  check("DELETE /vendor-bills/:id llama unlinkByDocument", /unlinkByDocument\(/.test(read("src/api/admin/vendor-bills/[id]/route.ts")));
  check("cancel de vendor bill llama unlinkByDocument antes del commit", (() => { const c = read("src/api/admin/vendor-bills/[id]/cancel/route.ts"); return /unlinkByDocument\(/.test(c) && c.indexOf("unlinkByDocument(") < c.indexOf("trx.commit()"); })());
  const feed = read("src/lib/banking/feed-confirm-document.ts");
  check("feed Create & match: la ocurrencia entra al preview (y por lo tanto al hash) con updated_at", /occurrence,\s*\n\s*\};/.test(feed) && /updated_at: occ\.updated_at/.test(feed));
  check("feed Create & match: enlaza DENTRO de la tx, antes de postear", feed.indexOf("lockLinkable(") > feed.indexOf("createBankCheck(") && feed.indexOf("linkOccurrence(") < feed.indexOf("postBankCheck("));
  check("NEGATIVO: el feed no enlaza un bill ni una entrada (sólo gl_check de salida)", /document !== "gl_check" \|\| occ\.status !== "expected" \|\| occ\.matched_id/.test(feed));
  const store = read("src/lib/banking/suggestion-store.ts");
  const insertCols = store.match(/INSERT INTO bank_statement_suggestion\(([^)]*)\)/)?.[1] ?? "expected";
  check("readFeedSuggestions adjunta `expected` (calculado al leer, no persistido)", /expectedHintsByTransaction\(/.test(store) && !/expected/.test(insertCols));
  const hints = read("src/lib/calendar/feed-expected-hints.ts");
  check("hint del feed: filtra por cuenta pagadora, monto en tolerancia y ±días; sólo salidas", /pay_from_account_list_id = a\.qb_list_id/.test(hints) && /GREATEST\(o\.tolerance_cents/.test(hints) && /t\.amount::numeric > 0/.test(hints));
  check("NEGATIVO: el motor de sugerencias no cambió de versión por esto", /SUGGEST_ENGINE_VERSION = "2026-09-15\.1"/.test(readFileSync(resolve(ROOT, "src/lib/banking/statement-suggest-types.ts"), "utf8")));
  const mw = read("src/api/middlewares.ts");
  check("idempotencia registrada para POST /admin/accounting/checks y /admin/vendor-bills", /matcher: "\/admin\/accounting\/checks",\s*\n\s*method: \["POST"\]/.test(mw) && /matcher: "\/admin\/vendor-bills",\s*\n\s*method: \["POST"\]/.test(mw));
  const guard = readFileSync(resolve(ROOT, "src/scripts/verify/verify-accounting-guard.ts"), "utf8");
  check("verify-accounting-guard declara prefill y scheduled", /occurrences\/\[id\]\/prefill\/route\.ts/.test(guard) && /recurring-expenses\/scheduled\/route\.ts/.test(guard));
  const occRoute = read("src/api/admin/accounting/recurring-expenses/occurrences/[id]/route.ts");
  check("PATCH de ocurrencia: move y patch, ninguno con PIN, errores de estado → 409 por código", /moveOccurrence\(/.test(occRoute) && /patchOccurrence\(/.test(occRoute) && !/requirePin\(/.test(occRoute) && /occurrenceErrorStatus\(/.test(occRoute));

  // La OTRA mitad del gate: las pantallas mandan lo que las rutas exigen.
  // Desde un worktree el vecino no es `../store-pos`: `STORE_POS_ROOT` lo apunta.
  const POS = process.env.STORE_POS_ROOT ? resolve(process.env.STORE_POS_ROOT) : resolve(ROOT, "../store-pos");
  const posRead = (rel: string) => {
    try {
      return readFileSync(resolve(POS, rel), "utf8");
    } catch {
      return ""; // archivo ausente = el check falla, no el script
    }
  };
  const ruleModal = posRead("app/(pos)/accounting/calendar/_components/RuleModal.tsx") + posRead("lib/calendar/api.ts");
  check("store-pos: la pantalla de reglas MANDA el PIN (supervisorPin / x-supervisor-pin)", /supervisorPin|x-supervisor-pin/.test(ruleModal));
  check("store-pos: CheckEditor manda recurring_occurrence_id al crear", /recurring_occurrence_id/.test(posRead("app/(pos)/accounting/checks/_components/CheckEditor.tsx")));
  check("store-pos: /vendor-bills/new manda recurring_occurrence_id al crear", /recurring_occurrence_id/.test(posRead("app/(pos)/vendor-bills/new/page.tsx")));
  check("store-pos: ConfirmDocumentModal manda occurrence_id en preview y confirm", /occurrence_id/.test(posRead("app/(pos)/accounting/banks/_components/ConfirmDocumentModal.tsx")));
  check("store-pos: la pestaña Scheduled existe y su fila mueve por moveOccurrence (PATCH due_date)", /fetchScheduled\(/.test(posRead("app/(pos)/accounting/calendar/_components/ScheduledTab.tsx")) && /moveOccurrence\(/.test(posRead("app/(pos)/accounting/calendar/_components/ScheduledRow.tsx")) && /body: \{ due_date \}/.test(posRead("lib/calendar/api.ts")));
}

async function main(): Promise<void> {
  section1();
  section2();
  await section3();
  section4();
  section5();
  await section6();
  section7();
  console.log(failures.length ? `\n❌ ${failures.length} check(s) fallaron: ${failures.join(" · ")}` : "\n✅ verify-calendars: todo verde");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
