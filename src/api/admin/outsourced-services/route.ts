/**
 * GET /admin/outsourced-services?tab=open|closed
 *
 * Una fila por servicio subcontratado. Sin paginación a propósito, igual que
 * comisiones: la población es chica y la pantalla filtra por fecha del lado del
 * cliente sobre el conjunto COMPLETO, así que los badges y la tabla no pueden
 * contradecirse.
 *
 * Antes de leer reconcilia: un bill que ya asentó en QuickBooks pasa su
 * servicio a `posted`. Es el mismo criterio de comisiones — QuickBooks es el
 * dueño del estado y el POS lo refleja.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../utils/db-pool";
import { reconcileServiceSettlements } from "../../../lib/outsourced-services/settle";
import { isOpen, type ServiceState } from "../../../lib/outsourced-services/transitions";
import { assertAccounting } from "./_lib/guard";

interface ListRow {
  id: string;
  order_id: string;
  display_number: string | number | null;
  state: ServiceState;
  qb_vendor_id: string;
  vendor_display_name: string;
  service_type_code: string;
  service_type_name: string;
  qb_account_full_name: string | null;
  amount_cents: string | number;
  description: string | null;
  vendor_invoice_number: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  settled_at: string | null;
  void_reason: string | null;
  order_display_id: string | null;
  order_document_number: string | null;
  order_status: string | null;
  settlement_id: string | null;
  settlement_status: string | null;
  settlement_failure_reason: string | null;
  vendor_bill_id: string | null;
  vendor_bill_number: string | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const tab = req.query.tab === "closed" ? "closed" : "open";
  const pool = getDbPool();

  // Refresh-on-read: cierra lo que QuickBooks ya asentó. No-op cuando no hay
  // nada que cerrar (la query interna sale vacía sin escribir).
  await reconcileServiceSettlements(pool).catch(() => 0);

  const { rows } = await pool.query<ListRow>(
    `SELECT o.id,
            o.order_id,
            o.display_number,
            o.state,
            o.qb_vendor_id,
            o.vendor_display_name,
            o.service_type_code,
            o.service_type_name,
            o.qb_account_full_name,
            o.amount_cents,
            o.description,
            o.vendor_invoice_number,
            o.assigned_by,
            o.assigned_at,
            o.approved_by,
            o.approved_at,
            o.settled_at,
            o.void_reason,
            ord.display_id::text          AS order_display_id,
            ord.metadata->>'document_number' AS order_document_number,
            ord.status                    AS order_status,
            s.id                          AS settlement_id,
            s.status                      AS settlement_status,
            s.failure_reason              AS settlement_failure_reason,
            s.vendor_bill_id,
            vb.number                     AS vendor_bill_number
       FROM order_outsourced_service o
       LEFT JOIN "order" ord ON ord.id = o.order_id
       LEFT JOIN LATERAL (
              SELECT st.id, st.status, st.failure_reason, st.vendor_bill_id
                FROM outsourced_service_settlement st
               WHERE st.service_id = o.id
               ORDER BY st.created_at DESC
               LIMIT 1
            ) s ON true
       LEFT JOIN vendor_bill vb ON vb.id = s.vendor_bill_id
      WHERE o.deleted_at IS NULL
      ORDER BY o.assigned_at DESC, o.id DESC`
  );

  const wanted = rows.filter((r) =>
    tab === "open" ? isOpen(r.state) : !isOpen(r.state)
  );

  res.json({
    tab,
    count: wanted.length,
    rows: wanted.map((r) => ({
      id: r.id,
      service_number: r.display_number ? `OSV-${r.display_number}` : null,
      state: r.state,
      is_open: isOpen(r.state),
      order_id: r.order_id,
      order_display_id: r.order_display_id,
      order_document_number: r.order_document_number,
      // Una orden cancelada con un servicio vivo tiene que SALTAR a la vista.
      // No se bloquea (el subcontratista igual trabajó), se muestra.
      order_status: r.order_status,
      qb_vendor_id: r.qb_vendor_id,
      vendor_display_name: r.vendor_display_name,
      service_type_code: r.service_type_code,
      service_type_name: r.service_type_name,
      qb_account_full_name: r.qb_account_full_name,
      amount_cents: Number(r.amount_cents),
      description: r.description,
      vendor_invoice_number: r.vendor_invoice_number,
      assigned_by: r.assigned_by,
      assigned_at: r.assigned_at,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      settled_at: r.settled_at,
      void_reason: r.void_reason,
      settlement: r.settlement_id
        ? {
            id: r.settlement_id,
            status: r.settlement_status,
            failure_reason: r.settlement_failure_reason,
            vendor_bill_id: r.vendor_bill_id,
            vendor_bill_number: r.vendor_bill_number,
          }
        : null,
    })),
  });
}
