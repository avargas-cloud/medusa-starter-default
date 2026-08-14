/**
 * GET  /admin/commissions/customer-vendor-link?customer_id=…
 * POST /admin/commissions/customer-vendor-link { customer_id, qb_vendor_id }
 *
 * La misma persona en las dos listas de QuickBooks (§3.7): QB Desktop comparte
 * namespace entre customers y vendors, así que el vendor espejo lleva el
 * sufijo " (Comm)" en el nombre. El ALTA del vendor va por el chokepoint
 * existente POST /admin/qb-catalog/vendors (el POS lo llama primero y después
 * registra el link acá) — esta ruta NO crea vendors, solo el vínculo 1↔1.
 *
 * Se referencia el id LOCAL (`qb_vendor.id`): el ListID de QB queda `pending_…`
 * hasta que el bridge confirma, y la liquidación es quien exige el ListID real.
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomUUID } from "crypto";

import { getDbPool } from "../../../utils/db-pool";
import { assertAccounting, getActorUserId } from "../_lib/guard";

export const COMMISSION_VENDOR_SUFFIX = " (Comm)";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const customerId = typeof req.query.customer_id === "string" ? req.query.customer_id : "";
  if (!customerId) {
    res.status(400).json({ error: "customer_id is required." });
    return;
  }
  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT l.id, l.customer_id, l.qb_vendor_id, l.vendor_full_name,
              v.qb_list_id AS vendor_qb_list_id, v.sync_status AS vendor_sync_status
         FROM customer_vendor_link l
         LEFT JOIN qb_vendor v ON v.id = l.qb_vendor_id
        WHERE l.customer_id = $1 AND l.deleted_at IS NULL
        LIMIT 1`,
      [customerId]
    );
    res.json({ link: rows[0] ?? null, suffix: COMMISSION_VENDOR_SUFFIX });
  } catch (err) {
    console.error("[commissions] link GET failed:", err);
    res.status(500).json({ error: "Could not load the link." });
  }
}

/**
 * DELETE /admin/commissions/customer-vendor-link?customer_id=…
 * Soft-borra el link (el vendor y el customer quedan intactos — solo se corta
 * la identidad 1↔1). Rechaza si el customer tiene una liquidación EN CURSO que
 * dependa del link: cortarla a mitad de camino dejaría documentos QB en vuelo
 * apuntando a una identidad que ya no existe.
 */
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  const customerId = typeof req.query.customer_id === "string" ? req.query.customer_id : "";
  if (!customerId) {
    res.status(400).json({ error: "customer_id is required." });
    return;
  }
  try {
    const pool = getDbPool();
    const { rows: busy } = await pool.query(
      `SELECT 1
         FROM order_commission_recipient r
         JOIN commission_settlement s ON s.recipient_id = r.id
        WHERE r.customer_id = $1 AND r.deleted_at IS NULL
          AND s.status IN ('pending', 'qb_waiting')
        LIMIT 1`,
      [customerId]
    );
    if (busy[0]) {
      res.status(409).json({
        error:
          "This customer has a settlement in flight that depends on the link — wait for it to confirm or fail before unlinking.",
        code: "settlement_in_flight",
      });
      return;
    }
    const { rowCount } = await pool.query(
      `UPDATE customer_vendor_link
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE customer_id = $1 AND deleted_at IS NULL`,
      [customerId]
    );
    if (!rowCount) {
      res.status(404).json({ error: "No live link for this customer." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[commissions] link DELETE failed:", err);
    res.status(500).json({ error: "Could not unlink the vendor." });
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const body = (req.body ?? {}) as { customer_id?: unknown; qb_vendor_id?: unknown };
  const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
  const qbVendorId = typeof body.qb_vendor_id === "string" ? body.qb_vendor_id : "";
  if (!customerId || !qbVendorId) {
    res.status(400).json({ error: "customer_id and qb_vendor_id are required." });
    return;
  }

  try {
    const pool = getDbPool();
    const { rows: customerRows } = await pool.query(
      `SELECT id FROM customer WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [customerId]
    );
    if (!customerRows[0]) {
      res.status(404).json({ error: "Customer not found." });
      return;
    }
    const { rows: vendorRows } = await pool.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM qb_vendor
        WHERE id = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
      [qbVendorId]
    );
    const vendor = vendorRows[0];
    if (!vendor) {
      res.status(404).json({ error: "Vendor not found or inactive." });
      return;
    }

    const id = `cvl_${randomUUID().replace(/-/g, "")}`;
    try {
      await pool.query(
        `INSERT INTO customer_vendor_link (id, customer_id, qb_vendor_id, vendor_full_name, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, customerId, qbVendorId, vendor.full_name, getActorUserId(req) ?? null]
      );
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        res.status(409).json({
          error: "The customer or the vendor is already linked to another identity.",
        });
        return;
      }
      throw err;
    }
    res.json({ ok: true, link_id: id });
  } catch (err) {
    console.error("[commissions] link POST failed:", err);
    res.status(500).json({ error: "Could not create the link." });
  }
}
