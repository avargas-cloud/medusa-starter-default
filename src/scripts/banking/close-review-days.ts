/**
 * close-review-days — cierra el Daily Close de Banking día por día, en orden, con las MISMAS
 * funciones que usa la pantalla (`readDailyReview` → `confirmDailyReview`): lee el día, toma su
 * `input_hash` y `revision`, y confirma sólo si `can_close` (0 pendientes, feed fresco, conexión
 * activa). Un día bloqueado frena la corrida y se reporta con sus motivos; nada se fuerza.
 *
 * El cierre diario es una FOTO de revisión (`bank_day_close`): no toca el libro ni QuickBooks.
 * Una línea casada por extracto (cerrado, o borrador con match) cuenta como revisada desde el
 * 2026-09-15 — antes ningún día podía cerrarse porque lo conciliado seguía "pendiente".
 *
 *   … ./node_modules/.bin/tsx src/scripts/banking/close-review-days.ts --from 2025-12-31 --to 2026-09-14 [--actor email] [--apply]
 *
 * DRY-RUN por default: tabla día → estado (cerrado / listo / bloqueado + motivos). Con `--apply`
 * cierra los listos en orden y para en el primer bloqueado. Idempotente: un día ya cerrado se saltea.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { confirmDailyReview } from "../../lib/banking/review-daily";
import { readDailyReview } from "../../lib/banking/review-daily-read";

function parseArgs(argv: string[]): { from: string; to: string; actor: string; apply: boolean } {
  const get = (flag: string): string | null => { const i = argv.indexOf(flag); return i >= 0 ? (argv[i + 1] ?? null) : null; };
  const from = get("--from"), to = get("--to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
    throw new Error("usage: --from YYYY-MM-DD --to YYYY-MM-DD [--actor email] [--apply]");
  return { from, to, actor: get("--actor") ?? "a.vargas@ecopowertech.com", apply: argv.includes("--apply") };
}

const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  let closedBefore = 0, ready = 0, blocked = 0, closedNow = 0;
  for (let day = args.from; day <= args.to; day = nextDay(day)) {
    const view = await readDailyReview(day);
    if (view.status === "closed") { closedBefore += 1; continue; }
    const pending = view.accounts.reduce((s, a) => s + a.pending_count, 0);
    if (!view.can_close) {
      blocked += 1;
      console.log(`${day}  BLOQUEADO  pendientes ${pending}  ${view.blockers.join(" · ")}`);
      if (args.apply) { console.log("→ se frena en el primer día bloqueado"); break; }
      continue;
    }
    ready += 1;
    if (!args.apply) { console.log(`${day}  listo      pendientes 0`); continue; }
    const out = await confirmDailyReview(actor.id, `close-review-days:${day}:${view.revision}`, {
      date: day, expected_revision: view.revision, input_hash: view.input_hash,
    });
    closedNow += 1;
    console.log(`${day}  CERRADO    rev ${out.revision}`);
  }
  console.log(`\n${args.from}..${args.to} · ya cerrados ${closedBefore} · listos ${ready} · bloqueados ${blocked}${args.apply ? ` · cerrados ahora ${closedNow}` : "\nDRY-RUN: no se escribió nada. Usá --apply."}`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("close-review-days:", e instanceof Error ? e.message : e); process.exit(1); });
