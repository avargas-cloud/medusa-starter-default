import { z } from "zod";

import { getDbPool } from "../../api/utils/db-pool";

import { confirmDailyReview } from "./review-daily";
import { readDailyReview } from "./review-daily-read";
import { reviewDate, reviewToday } from "./review-date";
import { BankingError, bankingEnvSql } from "./security";

/**
 * "Close through yesterday": cierra el Daily Close día por día, en orden, con las MISMAS funciones
 * que el botón de un día (`readDailyReview` → `confirmDailyReview`), y FRENA en el primer día que
 * no puede cerrar, devolviendo sus motivos. Es la lógica de `scripts/banking/close-review-days.ts`
 * como librería para que el contador la corra desde el POS (bank-feed-suggestions-20260915).
 * Nada se fuerza: un día con una línea sin casar (posted o pending en el banco) no cierra.
 * Un día ya cerrado se saltea; cada cierre lleva su propia Idempotency-Key derivada.
 */
export const closeThroughSchema = z.object({ through: reviewDate }).strict();
export type CloseThroughResult = {
  from: string | null;
  through: string;
  closed: string[];
  already_closed: number;
  stopped_at: string | null;
  blockers: string[];
};
export const CLOSE_THROUGH_MAX_DAYS = 62;

const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const prevDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Primer día a cerrar: el siguiente al último cerrado; sin cierres, el inicio de revisión más temprano. */
export async function firstOpenDay(): Promise<string | null> {
  const pool = getDbPool();
  const last = (await pool.query<{ day: string | null }>(`SELECT max(day)::text AS day FROM bank_day_close WHERE status='closed' AND deleted_at IS NULL`)).rows[0]?.day;
  if (last) return nextDay(last);
  const start = (
    await pool.query<{ day: string | null }>(
      `SELECT min(a.review_start_date)::text AS day FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
        WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} AND a.is_selected AND a.review_start_date IS NOT NULL`
    )
  ).rows[0]?.day;
  return start ?? null;
}

export async function closeDaysThrough(actorId: string, key: string, input: unknown): Promise<CloseThroughResult> {
  const body = closeThroughSchema.parse(input);
  if (body.through >= reviewToday()) throw new BankingError("BANKING_CLOSE_THROUGH_FUTURE", 409);
  const from = await firstOpenDay();
  const result: CloseThroughResult = { from, through: body.through, closed: [], already_closed: 0, stopped_at: null, blockers: [] };
  if (!from || from > body.through) return result;
  let steps = 0;
  for (let day = from; day <= body.through; day = nextDay(day)) {
    if (++steps > CLOSE_THROUGH_MAX_DAYS) {
      result.stopped_at = day;
      result.blockers = [`Stopped after ${CLOSE_THROUGH_MAX_DAYS} days; run again to continue from ${day}.`];
      break;
    }
    const view = await readDailyReview(day);
    if (view.status === "closed") {
      result.already_closed += 1;
      continue;
    }
    if (!view.can_close) {
      result.stopped_at = day;
      result.blockers = view.blockers;
      break;
    }
    await confirmDailyReview(actorId, `${key}:${day}:${view.revision}`, { date: day, expected_revision: view.revision, input_hash: view.input_hash });
    result.closed.push(day);
  }
  return result;
}

export const yesterday = (): string => prevDay(reviewToday());
