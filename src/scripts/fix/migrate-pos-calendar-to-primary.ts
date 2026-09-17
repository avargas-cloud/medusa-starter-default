/**
 * migrate-pos-calendar-to-primary.ts — mueve los eventos de los calendarios
 * secundarios "EcoPowerTech POS" (creados el 09/17/2026 con la primera versión
 * del calendario) al PRINCIPAL de cada usuario, ahora que el POS lee el
 * principal. Pega a Google con DWD: R3. Dry-run por default.
 *
 *   env DATABASE_URL=<prod> ./node_modules/.bin/tsx src/scripts/fix/migrate-pos-calendar-to-primary.ts
 *   env DATABASE_URL=<prod> APPLY=true ./node_modules/.bin/tsx …
 *
 * `events.move` conserva id, invitados y respuestas. El calendario secundario
 * queda vacío en la cuenta del usuario (borrarlo exige el scope calendar.calendars
 * que ya no pedimos): el usuario lo puede ocultar o borrar desde Google.
 * Idempotente: un evento ya movido no está en el secundario. Nunca imprime la clave.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import { PRIMARY_CALENDAR_ID, calendarFor, isDwdEligible } from "../../lib/calendar/google-calendar-client";

function loadKeyFromEnvFile(): void {
  if (process.env.GMAIL_SERVICE_ACCOUNT_KEY) return;
  const env = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("GMAIL_SERVICE_ACCOUNT_KEY="));
  if (line) process.env.GMAIL_SERVICE_ACCOUNT_KEY = line.slice("GMAIL_SERVICE_ACCOUNT_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
}

async function main(): Promise<void> {
  loadKeyFromEnvFile();
  const apply = process.env.APPLY === "true";
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = (await db.query(`SELECT user_id, email, google_calendar_id FROM pos_user_calendar ORDER BY created_at`)).rows as Array<{
    user_id: string; email: string; google_calendar_id: string;
  }>;
  await db.end();
  console.log(`${apply ? "APPLY" : "DRY-RUN"} · ${rows.length} calendario(s) secundario(s) registrados`);
  let moved = 0;
  for (const row of rows) {
    if (!isDwdEligible(row.email)) { console.log(`- ${row.email}: fuera del dominio, se salta`); continue; }
    const cal = calendarFor(row.email);
    let items: Array<{ id?: string | null; summary?: string | null; start?: { date?: string | null; dateTime?: string | null } }> = [];
    try {
      const res = await cal.events.list({ calendarId: row.google_calendar_id, maxResults: 2500, singleEvents: false, showDeleted: false });
      items = res.data.items ?? [];
    } catch (e: unknown) {
      const code = (e as { code?: number }).code;
      console.log(`- ${row.email}: no se pudo leer el secundario (HTTP ${code ?? "?"}) — ¿ya borrado? se salta`);
      continue;
    }
    console.log(`- ${row.email}: ${items.length} evento(s) en el secundario`);
    for (const ev of items) {
      if (!ev.id) continue;
      const when = ev.start?.date ?? ev.start?.dateTime ?? "?";
      if (!apply) { console.log(`    · ${when} "${ev.summary ?? "(sin título)"}" → primary (dry-run)`); continue; }
      await cal.events.move({ calendarId: row.google_calendar_id, eventId: ev.id, destination: PRIMARY_CALENDAR_ID, sendUpdates: "none" });
      moved += 1;
      console.log(`    ✓ ${when} "${ev.summary ?? "(sin título)"}" → primary`);
    }
  }
  console.log(apply ? `\n✅ movidos ${moved} evento(s)` : "\n(dry-run: nada movido)");
}

main().catch((e: unknown) => { console.error(`❌ ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`); process.exit(1); });
