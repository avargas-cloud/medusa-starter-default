/**
 * Order Commissions — configuración, leída de `store.metadata` (la misma capa
 * que la config de rounding y el resto del POS; ver lib/rounding/config.ts por
 * el razonamiento env-vs-DB).
 *
 * Dos clases de valores, con políticas distintas:
 *
 * · Parámetros de negocio (cap, días de espera): TIENEN default — son la regla
 *   que el owner fijó en el diseño (20% combinado, 30 días corridos) y el
 *   sistema funciona desde el día cero sin tocar Settings.
 *
 * · Cuentas de QuickBooks: SIN default, y se exigen LAS CUATRO juntas para
 *   liquidar. Adivinar una cuenta contable es peor que no escribir nada
 *   (misma postura que rounding). Faltando cualquiera, la liquidación queda
 *   apagada y la asignación sigue funcionando — el cap y el devengo no
 *   dependen de QB.
 *
 * El FullName viaja además del ListID porque el builder de ReceivePayment del
 * bridge referencia `DepositToAccountRef` por FullName, mientras que el de
 * Check referencia AccountRef por ListID — guardar los dos evita una query de
 * resolución en el camino caliente y deja legible el Settings.
 */

import { getDbPool } from "../../api/utils/db-pool";

/** Claves en `store.metadata`. */
export const COMMISSION_CONFIG_KEYS = {
  capBps: "commission_cap_bps",
  waitDays: "commission_wait_days",
  expenseAccountListId: "qb_commission_expense_account",
  expenseAccountFullName: "qb_commission_expense_account_name",
  clearingAccountListId: "qb_commission_clearing_account",
  clearingAccountFullName: "qb_commission_clearing_account_name",
} as const;

export const DEFAULT_CAP_BPS = 2000;
export const DEFAULT_WAIT_DAYS = 30;

export interface CommissionBusinessConfig {
  capBps: number;
  waitDays: number;
}

export interface CommissionQbAccounts {
  /** `Commission for Sale:Referral` (COGS) — la cuenta del gasto. */
  expenseAccountListId: string;
  expenseAccountFullName: string;
  /** `Referral Commission Clearing` (Bank) — el puente del caso crédito. */
  clearingAccountListId: string;
  clearingAccountFullName: string;
}

const TTL_MS = 60_000;
let cache: {
  business: CommissionBusinessConfig;
  qb: CommissionQbAccounts | null;
  loadedAt: number;
} | null = null;

/** La usa el endpoint de settings para que el proceso aplique el cambio ya. */
export function invalidateCommissionConfigCache(): void {
  cache = null;
}

function cleanStr(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

function cleanInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function load(): Promise<NonNullable<typeof cache>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache;

  let business: CommissionBusinessConfig = {
    capBps: DEFAULT_CAP_BPS,
    waitDays: DEFAULT_WAIT_DAYS,
  };
  let qb: CommissionQbAccounts | null = null;
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<Record<string, string | null>>(
      `SELECT metadata->>'${COMMISSION_CONFIG_KEYS.capBps}'                  AS cap_bps,
              metadata->>'${COMMISSION_CONFIG_KEYS.waitDays}'                AS wait_days,
              metadata->>'${COMMISSION_CONFIG_KEYS.expenseAccountListId}'    AS expense_list_id,
              metadata->>'${COMMISSION_CONFIG_KEYS.expenseAccountFullName}'  AS expense_full_name,
              metadata->>'${COMMISSION_CONFIG_KEYS.clearingAccountListId}'   AS clearing_list_id,
              metadata->>'${COMMISSION_CONFIG_KEYS.clearingAccountFullName}' AS clearing_full_name
         FROM store LIMIT 1`
    );
    const r = rows[0] ?? {};
    business = {
      capBps: cleanInt(r.cap_bps, DEFAULT_CAP_BPS),
      waitDays: cleanInt(r.wait_days, DEFAULT_WAIT_DAYS),
    };
    const expenseListId = cleanStr(r.expense_list_id);
    const expenseFullName = cleanStr(r.expense_full_name);
    const clearingListId = cleanStr(r.clearing_list_id);
    const clearingFullName = cleanStr(r.clearing_full_name);
    qb =
      expenseListId && expenseFullName && clearingListId && clearingFullName
        ? {
            expenseAccountListId: expenseListId,
            expenseAccountFullName: expenseFullName,
            clearingAccountListId: clearingListId,
            clearingAccountFullName: clearingFullName,
          }
        : null;
  } catch {
    // Fail-closed en cuentas (no liquidar sin config confirmada); los
    // parámetros de negocio caen a sus defaults de diseño.
    business = cache?.business ?? business;
    qb = cache?.qb ?? null;
  }

  cache = { business, qb, loadedAt: now };
  return cache;
}

export async function loadCommissionBusinessConfig(): Promise<CommissionBusinessConfig> {
  return (await load()).business;
}

/** `null` = liquidación apagada (falta al menos una cuenta). No es un error. */
export async function loadCommissionQbAccounts(): Promise<CommissionQbAccounts | null> {
  return (await load()).qb;
}
