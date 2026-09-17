/**
 * google-calendar-dwd-smoke.ts — prueba de punta a punta del acceso a Google
 * Calendar por Service Account + Domain-Wide Delegation con scope
 * `calendar.events.owned` (el calendario del POS es el PRINCIPAL del usuario).
 * Pega a GOOGLE de verdad: correrlo es R3 (crea y borra un evento en el
 * principal de la cuenta indicada).
 *
 *   env SMOKE_EMAIL=alguien@ecopowertech.com \
 *       GMAIL_SERVICE_ACCOUNT_KEY="$(…)"  ./node_modules/.bin/tsx src/scripts/debug/google-calendar-dwd-smoke.ts
 *
 * (Sin GMAIL_SERVICE_ACCOUNT_KEY en el entorno, lo lee de `.env` sin imprimirlo.)
 *
 * Pasos, y lo que prueba cada uno:
 *   1. control de scope: el principal es legible y `calendarList.list` NO
 *      (un scope que enumere calendarios es más amplio que el prometido → ABORTA).
 *   2. inserta un evento all-day en el principal → 3. lo lista → 4. lo convierte
 *      a hora y le agrega un guest → 5. lo borra (limpieza: no deja nada).
 * Nunca imprime la clave; sólo el client_id de la SA (para Admin Console).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  PRIMARY_CALENDAR_ID,
  deleteEvent,
  insertEvent,
  isDwdEligible,
  listEvents,
  probeScope,
  updateEvent,
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

  console.log("1. scope: primary legible, calendarList NO (calendar.events.owned)…");
  const probe = await probeScope(email);
  if (probe.result === "scope_not_authorized") {
    console.error(`⏸️  Google: ${probe.detail.slice(0, 160)}`);
    console.error("   El scope calendar.events.owned NO está autorizado para esta SA en Admin Console (o no propagó todavía). Nada que limpiar.");
    process.exit(3);
  }
  if (probe.result !== "narrow") {
    console.error(`❌ ${probe.result === "too_broad" ? "el scope de DWD es más amplio que calendar.events.owned (enumera calendarios)" : probe.detail}. ABORTO.`);
    process.exit(1);
  }
  console.log(`   ✅ ${probe.detail}`);

  const today = new Date().toISOString().slice(0, 10);
  console.log("2. insertar evento all-day en el principal…");
  const ev = await insertEvent(email, PRIMARY_CALENDAR_ID, { title: "POS smoke event", start: today, end: null, all_day: true });
  console.log(`   ✅ ${ev.ref}`);
  try {
    console.log("3. listar…");
    const list = await listEvents(email, PRIMARY_CALENDAR_ID, today, today);
    if (!list.some((e) => e.ref === ev.ref)) throw new Error("el evento insertado no aparece al listar");
    console.log(`   ✅ ${list.length} evento(s) hoy`);

    console.log("4. convertir all-day → con hora + guest (la misma cuenta)…");
    const timed = await updateEvent(email, PRIMARY_CALENDAR_ID, ev.ref, {
      title: "POS smoke event (timed)",
      start: `${today}T13:30:00-04:00`,
      end: `${today}T14:00:00-04:00`,
      all_day: false,
      attendees: [email],
    });
    if (timed.all_day || !timed.start.includes("T")) throw new Error("la conversión a hora no se aplicó");
    if (!timed.attendees?.some((a) => a.email === email.toLowerCase())) throw new Error("el guest no quedó en el evento");
    console.log(`   ✅ ${timed.start} → ${timed.end} · guests: ${timed.attendees.map((a) => a.email).join(",")}`);
  } finally {
    console.log("5. borrar evento (limpieza)…");
    await deleteEvent(email, PRIMARY_CALENDAR_ID, ev.ref);
    console.log("   ✅ sin rastro");
  }
  console.log("\n✅ DWD calendar.events.owned funciona para", email);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ ${msg.slice(0, 300)}`);
  process.exit(1);
});
