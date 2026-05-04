/**
 * Pure (no DB) computation of the tier0 window: live vs fallback mode.
 * Used by the engine AND by the API route, so the FE can label quarters
 * with the actual months the engine used.
 *
 * In fallback mode (Medusa < TIER0_MIN_BIZDAYS post-go-live), tier0 usually
 * uses the previous full calendar month from purchasing_sales_history.
 * April 2026 is the bridge month: combine QB Excel pre-go-live rows with
 * Medusa POS rows until the live window has enough post-go-live days.
 */

export const MEDUSA_GOLIVE_ISO = "2026-04-14";
/** Length of the LIVE tier0 window in Mon-Sat days. */
export const TIER0_LIVE_BIZDAYS = 26;
/** Min Mon-Sat days post-go-live before LIVE tier0 mode kicks in.
 *  Must equal TIER0_LIVE_BIZDAYS — otherwise the live window would dip into
 *  pre-go-live territory where Medusa has no pos_invoice rows. */
export const TIER0_MIN_BIZDAYS = TIER0_LIVE_BIZDAYS;

/** Mon–Sat days in [startISO, endISO). */
export function countMonSatBetween(startISO: string, endISO: string): number {
  const start = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    if (cur.getUTCDay() !== 0) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

export type Tier0Source =
  | "live_window"
  | "fallback_prev_month"
  | "april2026_combined";

export interface Tier0Meta {
  in_fallback_mode: boolean;
  source: Tier0Source;
  window_start: string; // YYYY-MM-DD inclusive
  window_end: string; // YYYY-MM-DD exclusive
  biz_days: number;
  label: string;
  /**
   * Months back from "today" (refDate) for each quarter slice [start, end].
   * In fallback mode, all offsets shift +1 because tier0 ate the most recent
   * month. q1 has the OLDEST months, q4 the most recent (just-before-tier0).
   */
  quarter_offsets: {
    q4: [number, number];
    q3: [number, number];
    q2: [number, number];
    q1: [number, number];
  };
}

/** Pure computation — no DB. Pass an ISO YYYY-MM-DD "today" in ET. */
export function computeTier0Meta(todayET: string): Tier0Meta {
  const [yStr, mStr] = todayET.split("-");
  const y = Number(yStr);
  const m = Number(mStr);

  const bizDaysSinceLive = countMonSatBetween(MEDUSA_GOLIVE_ISO, todayET);
  const inFallback = bizDaysSinceLive < TIER0_MIN_BIZDAYS;

  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;

  // Special-case April 2026 (the bridge month): combine QB Excel days 1-13
  // with Medusa pos_invoice days 14-window_end. This applies both during
  // April and in early May while Medusa still lacks a full live tier0 window.
  // Quarter offsets stay live-style because tier0 covers April only — Q4 is
  // jan-mar 26 (no overlap).
  if (inFallback && ((y === 2026 && m === 4) || (prevY === 2026 && prevM === 4))) {
    const window_start = "2026-04-01";
    const window_end = y === 2026 && m === 4 ? todayET : "2026-05-01";
    const endDay = parseInt(window_end.slice(8, 10), 10) - 1;
    const medusaEndLabel =
      window_end === "2026-05-01" ? "30" : String(endDay);
    return {
      in_fallback_mode: true,
      source: "april2026_combined",
      window_start,
      window_end,
      biz_days: countMonSatBetween(window_start, window_end),
      label: `Abril 2026 (QB días 1-13 + Medusa días 14-${medusaEndLabel})`,
      quarter_offsets: {
        q4: [3, 1],
        q3: [6, 4],
        q2: [9, 7],
        q1: [12, 10],
      },
    };
  }

  if (inFallback) {
    const mm = String(prevM).padStart(2, "0");
    const window_start = `${prevY}-${mm}-01`;
    const nextY = prevM === 12 ? prevY + 1 : prevY;
    const nextM = prevM === 12 ? 1 : prevM + 1;
    const window_end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
    return {
      in_fallback_mode: true,
      source: "fallback_prev_month",
      window_start,
      window_end,
      biz_days: countMonSatBetween(window_start, window_end),
      label: `Mes anterior (Medusa <${TIER0_MIN_BIZDAYS} días háb. live: ${bizDaysSinceLive})`,
      // Shift +1 month because tier0 used the most recent calendar month.
      quarter_offsets: {
        q4: [4, 2],
        q3: [7, 5],
        q2: [10, 8],
        q1: [13, 11],
      },
    };
  }

  // LIVE mode = exactly the last TIER0_LIVE_BIZDAYS Mon-Sat days ending at
  // yesterday (window_end is exclusive). Walk backwards from yesterday,
  // counting non-Sundays, until we have TIER0_LIVE_BIZDAYS of them — that day
  // becomes window_start. Always lands on a non-Sunday.
  const window_start = liveWindowStartISO(todayET, TIER0_LIVE_BIZDAYS);
  return {
    in_fallback_mode: false,
    source: "live_window",
    window_start,
    window_end: todayET,
    biz_days: countMonSatBetween(window_start, todayET),
    label: `Últimos ${TIER0_LIVE_BIZDAYS} días háb.`,
    quarter_offsets: {
      q4: [3, 1],
      q3: [6, 4],
      q2: [9, 7],
      q1: [12, 10],
    },
  };
}

/** Walk back from `todayET - 1` until we've counted `bizDays` Mon-Sat days.
 *  Returns the YYYY-MM-DD of the inclusive window start (always Mon-Sat). */
function liveWindowStartISO(todayET: string, bizDays: number): string {
  const today = new Date(todayET + "T00:00:00Z");
  const cur = new Date(today);
  cur.setUTCDate(cur.getUTCDate() - 1); // yesterday (inclusive)
  let counted = 0;
  while (counted < bizDays) {
    if (cur.getUTCDay() !== 0) {
      counted++;
      if (counted === bizDays) break;
    }
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return cur.toISOString().slice(0, 10);
}
