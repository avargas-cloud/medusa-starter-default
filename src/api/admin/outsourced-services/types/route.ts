/**
 * GET  /admin/outsourced-services/types  → catálogo + si la liquidación está viva
 * POST /admin/outsourced-services/types  → alta/edición de un tipo (PIN)
 *
 * A diferencia del GET de settings de comisiones, este SÍ lleva `assertAccounting`:
 * aquel quedó sin guard y expone las cuentas contables de la empresa.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  isSettleable,
  loadServiceTypes,
} from "../../../../lib/outsourced-services/config";
import { assertAccounting, requireSupervisorPin } from "../_lib/guard";

const LIST_ID_RE = /^[0-9A-Fa-f]{8}-\d+$/;
const CODE_RE = /^[a-z0-9_]+$/;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const pool = getDbPool();
  const types = await loadServiceTypes(pool, { includeInactive: true });

  res.json({
    types: types.map((t) => ({
      id: t.id,
      code: t.code,
      display_name: t.displayName,
      qb_account_list_id: t.qbAccountListId,
      qb_account_full_name: t.qbAccountFullName,
      sort_order: t.sortOrder,
      is_active: t.isActive,
      settleable: isSettleable(t),
    })),
    // Un tipo sin cuenta no liquida. Que ALGUNO liquide alcanza para prender el
    // badge — el kill switch real es por tipo y se aplica al aprobar.
    settlement_enabled: types.some((t) => t.isActive && isSettleable(t)),
  });
}

interface TypePatch {
  id?: unknown;
  code?: unknown;
  display_name?: unknown;
  qb_account_list_id?: unknown;
  qb_account_full_name?: unknown;
  sort_order?: unknown;
  is_active?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  if (!(await requireSupervisorPin(req, res))) return;

  const body = (req.body ?? {}) as TypePatch;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const displayName =
    typeof body.display_name === "string" ? body.display_name.trim() : "";
  const listId =
    typeof body.qb_account_list_id === "string"
      ? body.qb_account_list_id.trim()
      : null;
  const accountName =
    typeof body.qb_account_full_name === "string"
      ? body.qb_account_full_name.trim()
      : null;

  // La cuenta es un PAR: ListID para referenciar y FullName para mostrar y para
  // el allowlist. Aceptar uno solo deja una config que parece puesta y no lo está.
  if ((listId && !accountName) || (!listId && accountName)) {
    res.status(400).json({
      error: "Set the account ListID and its full name together, or neither.",
    });
    return;
  }
  if (listId && !LIST_ID_RE.test(listId)) {
    res.status(400).json({
      error: "The account ListID must look like 8-hex-XXXXXXXXXX.",
    });
    return;
  }

  const pool = getDbPool();

  if (id) {
    const { rowCount } = await pool.query(
      `UPDATE outsourced_service_type
          SET display_name = COALESCE(NULLIF($2,''), display_name),
              qb_account_list_id = $3,
              qb_account_full_name = $4,
              sort_order = COALESCE($5, sort_order),
              is_active = COALESCE($6, is_active),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        id,
        displayName,
        listId,
        accountName,
        typeof body.sort_order === "number" ? body.sort_order : null,
        typeof body.is_active === "boolean" ? body.is_active : null,
      ]
    );
    if (!rowCount) {
      res.status(404).json({ error: "Service type not found." });
      return;
    }
    res.json({ ok: true, id });
    return;
  }

  // Alta
  const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!CODE_RE.test(code)) {
    res.status(400).json({
      error: "The code must use lowercase letters, digits and underscores only.",
    });
    return;
  }
  if (!displayName) {
    res.status(400).json({ error: "Give the service type a display name." });
    return;
  }

  const newId = `ostp_${code}`;
  try {
    await pool.query(
      `INSERT INTO outsourced_service_type
         (id, code, display_name, qb_account_list_id, qb_account_full_name, sort_order)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, 100))`,
      [
        newId,
        code,
        displayName,
        listId,
        accountName,
        typeof body.sort_order === "number" ? body.sort_order : null,
      ]
    );
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: `A service type with code "${code}" already exists.` });
      return;
    }
    throw err;
  }
  res.json({ ok: true, id: newId });
}
