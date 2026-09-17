/**
 * google-calendar-dwd-smoke.ts — prueba de punta a punta del acceso a Google
 * Calendar por Service Account + Domain-Wide Delegation con scope
 * `calendar.app.created`. Pega a GOOGLE de verdad: correrlo es R3 (crea y
 * borra un calendario secundario en la cuenta indicada).
 *
 *   env SMOKE_EMAIL=alguien@ecopowertech.com \
 *       GMAIL_SERVICE_ACCOUNT_KEY="$(…)"  ./node_modules/.bin/tsx src/scripts/debug/google-calendar-dwd-smoke.ts
 *
 * (Sin GMAIL_SERVICE_ACCOUNT_KEY en el entorno, lo lee de `.env` sin imprimirlo.)
 *
 * Pasos, y lo que prueba cada uno:
 *   1. control NEGATIVO: `events.list(primary)` DEBE fallar (403/404). Si pasa,
 *      el scope habilitado en Admin Console es más amplio que el prometido → ABORTA.
 *   2. crea "EcoPowerTech POS (smoke)" → 3. inserta un evento → 4. lo lista →
 *   5. lo borra → 6. borra el calendario (limpieza: no deja nada en la cuenta).
 * Nunca imprime la clave; sólo el client_id de la SA (para Admin Console).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  calendarFor,
  deleteEvent,
  deletePosCalendar,
  insertEvent,
  isDwdEligible,
  listEvents,
  probePrimary,
} from "../../lib/calendar/google-calendar-client";

function loadKeyFromEnvFile(): void {
  if (process.env.GMAIL_SERVICE_ACCOUNT_KEY) return;
  const env = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("GMAIL_SERVICE_ACCOUNT_KEY="));
  if (line) process.env.GMAIL_SERVICE_ACCOUNT_KEY = line.slice("GMAIL_SERVICE_ACCOUNT_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
}

async function main(): Promise<void> {
  loadKeyFromEnvFile();
  const email = (process.env.SMOKE_EMAIL ?? "").trim();
  if (!email || !isDwdEligible(email)) {
    console.error("SMOKE_EMAIL debe ser una cuenta @ecopowertech.com");
    process.exit(2);
  }
  const key = JSON.parse(process.env.GMAIL_SERVICE_ACCOUNT_KEY ?? "{}") as { client_id?: string };
  console.log(`SA client_id: ${key.client_id ?? "?"} · subject: ${email}`);

  console.log("1. control negativo: events.list(primary) debe fallar…");
  const probe = await probePrimary(email);
  if (probe.result === "scope_not_authorized") {
    console.error(`⏸️  Google: ${probe.detail.slice(0, 160)}`);
    console.error("   El scope calendar.app.created NO está autorizado para esta SA en Admin Console (o no propagó todavía). Nada que limpiar.");
    process.exit(3);
  }
  if (probe.result !== "forbidden") {
    console.error(`❌ primary ${probe.result === "readable" ? "es LEGIBLE: el scope de DWD es más amplio que calendar.app.created" : `dio ${probe.detail}`}. ABORTO.`);
    process.exit(1);
  }
  console.log(`   ✅ primary rechazado (${probe.detail})`);

  console.log("2. crear calendario secundario…");
  const cal = calendarFor(email);
  const created = await cal.calendars.insert({ requestBody: { summary: "EcoPowerTech POS (smoke)", timeZone: "America/New_York" } });
  const calendarId = created.data.id;
  if (!calendarId) throw new Error("sin id de calendario");
  console.log(`   ✅ ${calendarId}`);

  try {
    console.log("3. insertar evento…");
    const today = new Date().toISOString().slice(0, 10);
    const ev = await insertEvent(email, calendarId, { title: "POS smoke event", start: today, end: null, all_day: true });
    console.log(`   ✅ ${ev.ref}`);

    console.log("4. listar…");
    const list = await listEvents(email, calendarId, today, today);
    if (!list.some((e) => e.ref === ev.ref)) throw new Error("el evento insertado no aparece al listar");
    console.log(`   ✅ ${list.length} evento(s)`);

    console.log("5. borrar evento…");
    await deleteEvent(email, calendarId, ev.ref);
    console.log("   ✅");
  } finally {
    console.log("6. borrar calendario (limpieza)…");
    await deletePosCalendar(email, calendarId);
    console.log("   ✅ sin rastro en la cuenta");
  }
  console.log("\n✅ DWD calendar.app.created funciona para", email);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ ${msg.slice(0, 300)}`);
  process.exit(1);
});
