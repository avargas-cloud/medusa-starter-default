/**
 * GET /admin/commissions/summary-1099?year=YYYY
 *
 * Acumulado por beneficiario por año calendario, SUMANDO los dos caminos
 * (§5.1 del plan). El camino bill/check entra solo al 1099 de QuickBooks; el
 * store_credit es fiscalmente reportable igual (IRS: referral fees y
 * compensación no monetaria a FMV) — este número es el que el contador
 * necesita en enero sin cruzar bills contra payments a mano.
 */
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import { assertAccounting } from "../_lib/guard";

// QB document dates use this same convention in two other places
// (`lib/quickbooks/order-flow-core.ts` QB_DOC_TIMEZONE, `lib/finance/batch-day.ts`
// BATCH_TIMEZONE) — neither is exported, so this is a third local copy of the
// same env-driven default, not a new convention.
const REPORT_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const now = new Date();
  const year = Number.parseInt(String(req.query.year ?? now.getUTCFullYear()), 10);
  if (!Number.isInteger(year) || year < 2020 || year > now.getUTCFullYear() + 1) {
    res.status(400).json({ error: "year is invalid." });
    return;
  }

  try {
    const pool = getDbPool();
    const { rows } = await pool.query(
      // Vendor EFECTIVO: mismo orden de resolución que el listado
      // (commissions/route.ts) y resolveBeneficiary() — la columna del
      // recipient o, para beneficiarios asignados por identidad de customer,
      // su customer_vendor_link. Agrupar por el crudo `r.qb_vendor_id`
      // partía en dos filas (dos nombres) al mismo beneficiario.
      `SELECT COALESCE(v.full_name, r.display_name)           AS beneficiary,
              COALESCE(r.qb_vendor_id, cvl.qb_vendor_id)      AS qb_vendor_id,
              SUM(s.amount_cents)::bigint                     AS total_cents,
              SUM(s.amount_cents)
                FILTER (WHERE s.method = 'vendor_bill')::bigint AS bill_cents,
              SUM(s.amount_cents)
                FILTER (WHERE s.method = 'store_credit')::bigint AS credit_cents,
              COUNT(*)                                        AS settlements
         FROM commission_settlement s
         JOIN order_commission_recipient r ON r.id = s.recipient_id
         LEFT JOIN LATERAL (
           SELECT l.qb_vendor_id FROM customer_vendor_link l
            WHERE l.customer_id = r.customer_id AND l.deleted_at IS NULL
            LIMIT 1
         ) cvl ON TRUE
         LEFT JOIN qb_vendor v ON v.id = COALESCE(r.qb_vendor_id, cvl.qb_vendor_id)
        WHERE s.status = 'confirmed'
          -- Convertido a la zona horaria del negocio ANTES de extraer el año:
          -- timestamptz sobre la sesión (UTC en Railway) corre una
          -- liquidación de fin de diciembre en horario del este al año
          -- siguiente — esto es un reporte fiscal.
          AND EXTRACT(YEAR FROM (COALESCE(r.settled_at, s.updated_at) AT TIME ZONE $2)) = $1
        GROUP BY 1, 2
        ORDER BY total_cents DESC`,
      [year, REPORT_TIMEZONE]
    );
    res.json({ year, beneficiaries: rows });
  } catch (err) {
    console.error("[commissions] summary-1099 failed:", err);
    res.status(500).json({ error: "Could not compute the 1099 accumulator." });
  }
}
