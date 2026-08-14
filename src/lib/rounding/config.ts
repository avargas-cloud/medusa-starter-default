/**
 * src/lib/rounding/config.ts
 *
 * Las tres cuentas de QuickBooks del write-off de redondeo, leídas de
 * `store.metadata` — la misma capa donde ya vive el resto de la config del POS
 * (`payment_batch_cutoff`, `pos_supervisor_pin`).
 *
 * ── Por qué en la base y no en env ────────────────────────────────────────────
 * Empezó como env vars, siguiendo el precedente de
 * `QB_DAMAGED_RETURNS_ACCOUNT_LIST_ID`. Se movió acá el 2026-08-13 por un motivo
 * medido, no teórico: **una env var se pierde al reiniciar y no deja rastro.**
 * Durante el desarrollo el mecanismo quedó apagado en silencio DOS veces porque
 * el backend del sandbox se reinició con un wrapper que no las lleva, y la
 * segunda vez costó una corrida entera del E2E entender que el rojo era config
 * ausente y no un bug de lógica.
 *
 * Tres razones más, todas ausentes en env:
 *   · cambiar una cuenta no exige un deploy ni un restart;
 *   · el contador y el operador PUEDEN VERLAS (Settings del POS), en vez de que
 *     vivan invisibles en el panel de Railway;
 *   · queda auditoría de quién las cambió y cuándo.
 *
 * UNA sola fuente, nunca env+DB a la vez: dos fuentes para el mismo valor es
 * exactamente cómo terminan divergiendo, y este repo ya se comió esa lección
 * varias veces (el guard con dos constantes, el scope del pipeline en tres
 * lugares).
 *
 * ── El kill switch no cambia de semántica, cambia de lugar ────────────────────
 * Faltando CUALQUIERA de las tres, el mecanismo queda apagado y el sistema se
 * comporta exactamente como antes de que existiera. **No hay cuenta por
 * defecto**: adivinar una cuenta contable es peor que no escribir nada.
 *
 * Se exigen las TRES juntas porque una orden puede producir residuo en
 * cualquiera de las dos direcciones, y el overage además necesita A/R: media
 * configuración dejaría un subconjunto de casos fallando recién en producción,
 * con la plata ya cobrada.
 */

import { getDbPool } from "../../api/utils/db-pool";

/** Claves en `store.metadata`. Valores = `ListID` de QuickBooks. */
export const ROUNDING_CONFIG_KEYS = {
  shortage: "qb_rounding_shortage_account",
  overage: "qb_rounding_overage_account",
  ar: "qb_ar_account",
} as const;

export interface RoundingConfig {
  /** `Cash Discrepancies:Shortages` — absorbemos (ingreso negativo). */
  shortageAccountListId: string;
  /** `Cash Discrepancies:Overages` — sobró plata (ingreso positivo). */
  overageAccountListId: string;
  /** `Accounts Receivable` — la contrapartida del asiento de overage. */
  arAccountListId: string;
}

const TTL_MS = 60_000;
let cache: { value: RoundingConfig | null; loadedAt: number } | null = null;

/** La usa el PUT de settings para que el proceso actual aplique el cambio ya. */
export function invalidateRoundingConfigCache(): void {
  cache = null;
}

function clean(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

/**
 * Devuelve la config completa, o `null` si falta cualquiera de las tres.
 *
 * `null` significa **apagado**, y es un resultado legítimo — no un error. Ante
 * un fallo de lectura devuelve el último valor cacheado o `null`: fail-closed,
 * porque escribir un asiento contra una cuenta que no se pudo confirmar es peor
 * que no escribirlo.
 */
export async function loadRoundingConfig(): Promise<RoundingConfig | null> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache.value;

  let value: RoundingConfig | null = null;
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{
      shortage: string | null;
      overage: string | null;
      ar: string | null;
    }>(
      `SELECT metadata->>'${ROUNDING_CONFIG_KEYS.shortage}' AS shortage,
              metadata->>'${ROUNDING_CONFIG_KEYS.overage}'  AS overage,
              metadata->>'${ROUNDING_CONFIG_KEYS.ar}'       AS ar
         FROM store LIMIT 1`
    );
    const r = rows[0];
    const shortage = clean(r?.shortage);
    const overage = clean(r?.overage);
    const ar = clean(r?.ar);
    value =
      shortage && overage && ar
        ? {
            shortageAccountListId: shortage,
            overageAccountListId: overage,
            arAccountListId: ar,
          }
        : null;
  } catch {
    // Fail-closed: sin poder leer la config, el mecanismo no escribe.
    value = cache?.value ?? null;
  }

  cache = { value, loadedAt: now };
  return value;
}
