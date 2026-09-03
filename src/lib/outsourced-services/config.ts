/**
 * Order Outsourced Services — catálogo de tipos y kill switch.
 *
 * El catálogo vive en TABLA (`outsourced_service_type`), no en `store.metadata`
 * como el de comisiones. La razón es que acá la configuración mapea cada tipo a
 * una cuenta CONTABLE: eso quiere integridad referencial y auditoría, no un JSON
 * laxo detrás de un cache — y `updateStores` REEMPLAZA metadata entero, que es
 * una trampa conocida de este repo.
 *
 * Kill switch PROPIO, separado del de comisiones a propósito: que falte la
 * cuenta de comisiones no debe apagar servicios, ni al revés. Y es por TIPO —
 * si el contador todavía no mapeó "Assembly", ese tipo no liquida mientras los
 * otros dos siguen operando.
 */

import type { Pool, PoolClient } from "pg";

export interface ServiceType {
  id: string;
  code: string;
  displayName: string;
  qbAccountListId: string | null;
  qbAccountFullName: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** Un tipo que puede liquidar: tiene cuenta contable resuelta. */
export interface SettleableServiceType extends ServiceType {
  qbAccountListId: string;
  qbAccountFullName: string;
}

export function isSettleable(t: ServiceType): t is SettleableServiceType {
  return t.qbAccountListId !== null && t.qbAccountFullName !== null;
}

type Db = Pool | PoolClient;

interface TypeRow {
  id: string;
  code: string;
  display_name: string;
  qb_account_list_id: string | null;
  qb_account_full_name: string | null;
  sort_order: number | string;
  is_active: boolean;
}

const toServiceType = (r: TypeRow): ServiceType => ({
  id: r.id,
  code: r.code,
  displayName: r.display_name,
  qbAccountListId: r.qb_account_list_id,
  qbAccountFullName: r.qb_account_full_name,
  sortOrder: Number(r.sort_order),
  isActive: r.is_active,
});

/**
 * Lee el catálogo. SIN cache, a diferencia del de comisiones: se consulta una
 * vez por request y el TTL de 60 s de allá ya costó una espera de un minuto
 * para ver un cambio de settings reflejado. Son tres filas.
 */
export async function loadServiceTypes(
  db: Db,
  opts?: { includeInactive?: boolean }
): Promise<ServiceType[]> {
  const { rows } = await db.query<TypeRow>(
    `SELECT id, code, display_name, qb_account_list_id, qb_account_full_name,
            sort_order, is_active
       FROM outsourced_service_type
      WHERE deleted_at IS NULL
        ${opts?.includeInactive ? "" : "AND is_active = true"}
      ORDER BY sort_order, display_name`
  );
  return rows.map(toServiceType);
}

export async function loadServiceType(
  db: Db,
  serviceTypeId: string
): Promise<ServiceType | null> {
  const { rows } = await db.query<TypeRow>(
    `SELECT id, code, display_name, qb_account_list_id, qb_account_full_name,
            sort_order, is_active
       FROM outsourced_service_type
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [serviceTypeId]
  );
  const row = rows[0];
  return row ? toServiceType(row) : null;
}

/**
 * ¿Hay al menos un tipo activo capaz de liquidar? Alimenta el badge
 * "Settlement ON/OFF" de Settings. Que dé false no impide REGISTRAR servicios —
 * igual que en comisiones, apagar la liquidación no apaga la captura del costo.
 */
export async function isSettlementEnabled(db: Db): Promise<boolean> {
  const types = await loadServiceTypes(db);
  return types.some(isSettleable);
}

/**
 * Las cuentas que un bill de servicio puede usar. `vendor-bill-account-rules.ts`
 * lee esta MISMA lista, así que ampliar el catálogo no exige tocar el allowlist.
 */
export async function loadServiceAccountListIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ qb_account_list_id: string }>(
    `SELECT DISTINCT qb_account_list_id
       FROM outsourced_service_type
      WHERE deleted_at IS NULL AND qb_account_list_id IS NOT NULL`
  );
  return rows.map((r) => r.qb_account_list_id);
}
