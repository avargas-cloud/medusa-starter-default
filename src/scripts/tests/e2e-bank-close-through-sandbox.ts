/**
 * e2e-bank-close-through-sandbox.ts — plan bank-feed-suggestions-20260915, Fase 5.
 * "Close through yesterday" como librería: cierra en orden desde el día siguiente al último cerrado
 * y frena en el primer bloqueado con sus motivos. Contra el clon `medusa_sug` (días cerrados hasta
 * el 09/13; el 09/14 real está bloqueado por líneas pending del banco).
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_sug' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-close-through-sandbox.ts
 *
 *   1. `through` ≥ hoy → BANKING_CLOSE_THROUGH_FUTURE, nada cambia.
 *   2. Se reabre el último día cerrado (fixture) → close-through lo vuelve a cerrar y frena en el
 *      siguiente (bloqueado) devolviendo `stopped_at` y los motivos; `already_closed` cuenta los saltados.
 *   3. Idempotente: la misma llamada de nuevo no cierra nada nuevo (already_closed sube, closed vacío).
 *   NEGATIVO: el día bloqueado sigue `open` en bank_day_close.
 */
import assert from "node:assert/strict";

import { getDbPool } from "../../api/utils/db-pool";
import { closeDaysThrough, firstOpenDay } from "../../lib/banking/review-daily-close-through";
import { reopenDailyReview } from "../../lib/banking/review-daily";
import { readDailyReview } from "../../lib/banking/review-daily-read";
import { reviewToday } from "../../lib/banking/review-date";
import { requireBankingSandbox } from "../../lib/banking/security";

let checks = 0;
const check = (ok: boolean, label: string): void => { assert(ok, label); checks++; console.log(`  ✓ ${label}`); };
const prevDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  await pool.query(`UPDATE bank_connection SET status='active', last_successful_sync_at=now() WHERE deleted_at IS NULL`);
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='contador@test.com'`)).rows[0]!.id;
  const RUN = Date.now().toString(36);
  const last = (await pool.query<{ day: string }>(`SELECT max(day)::text AS day FROM bank_day_close WHERE status='closed' AND deleted_at IS NULL`)).rows[0]!.day;
  assert(last, "el clon tiene días cerrados");
  const yesterday = prevDay(reviewToday());
  console.log(`último cerrado ${last} · hoy ${reviewToday()} · primer abierto ${await firstOpenDay()}`);

  // 1. Futuro/hoy.
  let err = "";
  try { await closeDaysThrough(actor, `e2e-ct-${RUN}-future`, { through: reviewToday() }); } catch (e) { err = (e as { code?: string }).code ?? String(e); }
  check(err === "BANKING_CLOSE_THROUGH_FUTURE", `through = hoy → ${err}`);

  // 2. Reabrir el último cerrado y volver a cerrar por close-through.
  const view = await readDailyReview(last);
  await reopenDailyReview(actor, `e2e-ct-${RUN}-reopen`, { date: last, expected_revision: view.revision, reason: `e2e close-through ${RUN}` });
  check((await readDailyReview(last)).status === "open" && (await firstOpenDay()) === last, `fixture: ${last} reabierto → primer abierto = ${last}`);
  const r = await closeDaysThrough(actor, `e2e-ct-${RUN}`, { through: yesterday });
  console.log(`  close-through ${yesterday}: from ${r.from} · cerrados ${r.closed.join(",") || "-"} · saltados ${r.already_closed} · frenó en ${r.stopped_at ?? "-"} · ${r.blockers.join(" · ")}`);
  check(r.from === last && r.closed[0] === last, `cerró ${last} primero`);
  check((await readDailyReview(last)).status === "closed", `${last} vuelve a estar cerrado`);
  if (r.stopped_at) {
    check(r.blockers.length > 0 && (await readDailyReview(r.stopped_at)).status === "open", `frenó en ${r.stopped_at} con motivo: ${r.blockers[0]}`);
    check(r.closed.every((d) => d < r.stopped_at!), "sólo cerró días ANTES del bloqueado");
  } else {
    check(r.closed[r.closed.length - 1] === yesterday, "sin bloqueos: cerró hasta ayer");
  }

  // 3. Idempotente.
  const r2 = await closeDaysThrough(actor, `e2e-ct-${RUN}-again`, { through: yesterday });
  check(r2.closed.length === 0 && r2.stopped_at === r.stopped_at && r2.from === (r.stopped_at ?? r2.from), `segunda llamada: nada nuevo, arranca en ${r2.from} y frena igual`);

  console.log(`\n${checks} checks OK`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("e2e-bank-close-through:", e instanceof Error ? e.message : e); process.exit(1); });
