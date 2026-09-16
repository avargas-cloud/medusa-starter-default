import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { accessFailure, assertAccounting } from "../../../../lib/pos/access-level";
import { getDbPool } from "../../../utils/db-pool";

/**
 * GET /admin/qb-catalog/other-names?q=&all=1 — la lista Other Names de QuickBooks
 * cacheada por `POST …/other-names/sync`. Activos por default; `all=1` incluye
 * los apagados (para mostrar el nombre de un documento viejo). `q` filtra por
 * substring, sin acentos ni mayúsculas. Son <100 filas: el POS puede pedirla
 * entera y filtrar en memoria.
 *
 * → { items: [{ id, qb_list_id, name, is_active }], synced_at: ISO | null }
 */
export type QbOtherNameDto = {
  id: string;
  qb_list_id: string;
  name: string;
  is_active: boolean;
};

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const all = req.query.all === "1" || req.query.all === "true";
  const { rows } = await getDbPool().query<QbOtherNameDto & { synced_at: string | null }>(
    `SELECT id, qb_list_id, name, is_active,
            (SELECT max(last_synced_at) FROM qb_other_name WHERE deleted_at IS NULL)::text AS synced_at
       FROM qb_other_name
      WHERE deleted_at IS NULL
        AND ($1::boolean OR is_active = true)
        AND ($2::text = '' OR name ILIKE '%' || $2 || '%')
      ORDER BY lower(name) ASC
      LIMIT 500`,
    [all, q]
  );
  const synced_at = rows[0]?.synced_at ?? null;
  return res.json({
    items: rows.map(({ id, qb_list_id, name, is_active }) => ({ id, qb_list_id, name, is_active })),
    synced_at,
  });
};
