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
 * §5 Google (estático + puro): el scope es ÚNICAMENTE calendar.app.created; el
 *    cliente de Google no acepta un email que no sea del dominio; las rutas
 *    del calendario personal no leen emails del request; `user_id` sólo pasa
 *    por `resolveCalendarTarget`, que exige owner; el mapeo all-day
 *    inclusivo↔exclusivo de Google es simétrico.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import { generateOccurrences, viewStatus } from "../../lib/calendar/recurring-occurrences";
import { parseOccurrencePatch, parseRecurringRule } from "../../lib/calendar/recurring-types";
import { CALENDAR_SCOPE, isDwdEligible, toCalendarEvent } from "../../lib/calendar/google-calendar-client";
import { parsePersonalEvent } from "../../lib/calendar/personal-calendar";
import {
  createRule,
  listOccurrences,
  materializeRule,
  rematerializeFuture,
  patchOccurrence,
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
  check("scope es exactamente calendar.app.created", CALENDAR_SCOPE === "https://www.googleapis.com/auth/calendar.app.created");
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
  const mig = readFileSync(resolve(ROOT, "src/migrations/Migration20260917110000-PosUserCalendar.ts"), "utf8");
  check("pos_user_calendar guarda sólo ids (ni tokens ni claves)", /google_calendar_id/.test(mig) && !/token|secret|private_key/i.test(mig));
}

async function main(): Promise<void> {
  section1();
  section2();
  await section3();
  section4();
  section5();
  console.log(failures.length ? `\n❌ ${failures.length} check(s) fallaron: ${failures.join(" · ")}` : "\n✅ verify-calendars: todo verde");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
