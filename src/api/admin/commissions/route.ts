/**
 * GET /admin/commissions?tab=open|closed — listado para la página de Accounting.
 *
 * Grano = BENEFICIARIO (una fila por recipient): OPEN agrupa todo lo anterior a
 * closed/void con el estado real como columna (§6 del plan); CLOSED lo terminal.
 *
 * Refresh-on-read (baratísimo al volumen de esta feature, cap defensivo):
 *  · reconcilia settlements de vendor_bill cuyo bill ya confirmó en QB;
 *  · re-deriva devengo (draft↔eligible) de las comisiones abiertas.
 * Sin paginación a propósito (regla de listados del repo: no paginar hasta ~1MB).
 */
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../utils/db-pool";
import { readOrderMoneySnapshot } from "../../../lib/commissions/order-money";
import { refreshCommission, withOrderCommissionLock, asInt } from "../../../lib/commissions/writer";
import {
  checkCombinedCap,
  effectiveAmountCents,
  effectiveBps,
  type CapCheckResult,
  type CommissionAmountMode,
} from "../../../lib/commissions/calculator";
import { reconcileVendorBillSettlements } from "../../../lib/commissions/settle";
import { isOpen, type RecipientState } from "../../../lib/commissions/transitions";
import { assertAccounting } from "./_lib/guard";

const REFRESH_CAP = 100;

interface ListRow {
  id: string;
  order_fully_paid: boolean;
  last_invoice_at: Date | null;
  approval_ready_at: Date | null;
  wait_days: number;
  assigned_by_email: string | null;
  approved_by_email: string | null;
  settled_by_email: string | null;
  state: RecipientState;
  percent_bps: number;
  amount_cents: string | number | null;
  amount_mode: CommissionAmountMode;
  fixed_amount_cents: string | number | null;
  eligible_at: Date | null;
  payout_method: string | null;
  display_name: string;
  customer_id: string | null;
  qb_vendor_id: string | null;
  assigned_by: string | null;
  assigned_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  settled_by: string | null;
  settled_at: Date | null;
  void_reason: string | null;
  commission_id: string;
  commission_display_number: string | number | null;
  order_id: string;
  base_cents: string | number;
  discount_bps: number;
  cap_bps: number;
  currency_code: string;
  order_display_id: string | number | null;
  order_document_number: string | null;
  settlement_id: string | null;
  settlement_method: string | null;
  settlement_status: string | null;
  vendor_bill_id: string | null;
  customer_payment_id: string | null;
  qb_check_txn_id: string | null;
  qb_payment_txn_id: string | null;
  failure_reason: string | null;
  vendor_bill_number: string | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!(await assertAccounting(req, res))) return;

  const tab = req.query.tab === "closed" ? "closed" : "open";
  const pool = getDbPool();
  try {
    // 1 · Reconciliar bills confirmados (QB es el dueño; el POS refleja).
    const client = await pool.connect();
    try {
      await reconcileVendorBillSettlements(client);
    } finally {
      client.release();
    }

    // 2 · Re-derivar devengo de las comisiones con beneficiarios movibles.
    const { rows: openOrders } = await pool.query<{ order_id: string }>(
      `SELECT DISTINCT c.order_id
         FROM order_commission c
         JOIN order_commission_recipient r
           ON r.order_commission_id = c.id AND r.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND r.state IN ('draft', 'eligible')
        LIMIT $1`,
      [REFRESH_CAP]
    );
    for (const { order_id } of openOrders) {
      try {
        await withOrderCommissionLock(pool, order_id, async (c) => {
          const money = await readOrderMoneySnapshot(c, order_id);
          if (money) await refreshCommission(c, order_id, money);
        });
      } catch (err) {
        console.warn(`[commissions] list refresh failed for ${order_id}:`, err);
      }
    }

    // Misma derivación que el modal de la orden: una fila fija vale su monto,
    // una por % vale base × bps. Dos lectores del mismo dato NO pueden tener
    // dos fórmulas — se contradicen en pantalla sin que nada avise.
    const toRecipientAmount = (r: ListRow) => ({
      mode: r.amount_mode,
      percentBps: r.percent_bps,
      fixedAmountCents: r.fixed_amount_cents == null ? null : asInt(r.fixed_amount_cents),
    });

    // 3 · Listado.
    const stateFilter =
      tab === "open"
        ? `r.state NOT IN ('closed', 'void')`
        : `r.state IN ('closed', 'void')`;
    const { rows } = await pool.query<ListRow>(
      `SELECT r.id, r.state, r.percent_bps, r.amount_cents, r.eligible_at,
              r.amount_mode, r.fixed_amount_cents,
              r.payout_method, r.display_name, r.customer_id,
              -- Vendor EFECTIVO: la columna del recipient o, para beneficiarios
              -- asignados por identidad de customer, su customer_vendor_link —
              -- mismo orden de resolución que resolveBeneficiary() en settle.
              COALESCE(r.qb_vendor_id, cvl.qb_vendor_id) AS qb_vendor_id,
              r.assigned_by, r.assigned_at, r.approved_by, r.approved_at,
              r.settled_by, r.settled_at, r.void_reason,
              c.id AS commission_id, c.display_number AS commission_display_number,
              c.order_id, c.base_cents, c.discount_bps,
              c.cap_bps, c.wait_days, c.currency_code,
              o.display_id AS order_display_id,
              o.metadata->>'document_number' AS order_document_number,
              -- Las DOS condiciones del devengo, por separado (la UI las muestra
              -- explícitas): pago completo hoy, y última factura + espera.
              COALESCE(omp.order_total_cents > 0
                AND omp.applied_cents + omp.deposit_cents >= omp.order_total_cents,
                FALSE) AS order_fully_paid,
              inv.last_invoice_at,
              inv.last_invoice_at + (c.wait_days || ' days')::interval AS approval_ready_at,
              ua.email AS assigned_by_email,
              uap.email AS approved_by_email,
              us.email AS settled_by_email,
              s.id AS settlement_id, s.method AS settlement_method,
              s.status AS settlement_status, s.vendor_bill_id,
              s.customer_payment_id, s.qb_check_txn_id, s.qb_payment_txn_id,
              s.failure_reason,
              svb.number AS vendor_bill_number
         FROM order_commission_recipient r
         JOIN order_commission c
           ON c.id = r.order_commission_id AND c.deleted_at IS NULL
         LEFT JOIN "order" o ON o.id = c.order_id
         LEFT JOIN order_money_projection omp ON omp.order_id = c.order_id
         LEFT JOIN LATERAL (
           SELECT MAX(pi.created_at) AS last_invoice_at
             FROM pos_invoice pi
            WHERE pi.order_id = c.order_id
              AND pi.deleted_at IS NULL AND pi.status NOT IN ('draft', 'voided')
         ) inv ON TRUE
         LEFT JOIN LATERAL (
           SELECT l.qb_vendor_id FROM customer_vendor_link l
            WHERE l.customer_id = r.customer_id AND l.deleted_at IS NULL
            LIMIT 1
         ) cvl ON TRUE
         LEFT JOIN "user" ua ON ua.id = r.assigned_by
         LEFT JOIN "user" uap ON uap.id = r.approved_by
         LEFT JOIN "user" us ON us.id = r.settled_by
         LEFT JOIN LATERAL (
           SELECT * FROM commission_settlement cs
            WHERE cs.recipient_id = r.id
            ORDER BY cs.created_at DESC, cs.id DESC
            LIMIT 1
         ) s ON TRUE
         LEFT JOIN vendor_bill svb
           ON svb.id = s.vendor_bill_id AND svb.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND ${stateFilter}
        ORDER BY r.assigned_at DESC, r.id DESC`
    );

    // 4 · Cap combinado por comisión. El listado es UNA FILA POR BENEFICIARIO
    // y filtra por tab (open/closed): sumar los bps de las filas TRAÍDAS
    // subestimaría el combinado en el tab 'open' (faltarían los 'closed' de
    // la misma comisión) — subestimar un cap es el peor error posible acá.
    // Por eso se trae TODOS los recipients no-void de cada comisión referida,
    // sin filtro de tab, y se calcula UNA VEZ por comisión con la MISMA
    // función que usa el resto del feature (nunca SQL que replique la fórmula).
    const commissionIds = Array.from(new Set(rows.map((r) => r.commission_id)));
    const capByCommission = new Map<string, CapCheckResult>();
    if (commissionIds.length > 0) {
      const { rows: capRows } = await pool.query<{
        commission_id: string;
        item_subtotal_cents: string | number;
        discount_cents: string | number;
        cap_bps: number;
        amount_mode: CommissionAmountMode;
        percent_bps: number;
        fixed_amount_cents: string | number | null;
      }>(
        `SELECT c.id AS commission_id, c.item_subtotal_cents, c.discount_cents, c.cap_bps,
                r.amount_mode, r.percent_bps, r.fixed_amount_cents
           FROM order_commission c
           JOIN order_commission_recipient r
             ON r.order_commission_id = c.id AND r.deleted_at IS NULL AND r.state != 'void'
          WHERE c.id = ANY($1::text[])`,
        [commissionIds]
      );
      const grouped = new Map<
        string,
        { itemSubtotalCents: number; discountCents: number; capBps: number; recipients: Array<{
          mode: CommissionAmountMode;
          percentBps: number;
          fixedAmountCents: number | null;
        }> }
      >();
      for (const cr of capRows) {
        let entry = grouped.get(cr.commission_id);
        if (!entry) {
          entry = {
            itemSubtotalCents: asInt(cr.item_subtotal_cents),
            discountCents: asInt(cr.discount_cents),
            capBps: cr.cap_bps,
            recipients: [],
          };
          grouped.set(cr.commission_id, entry);
        }
        entry.recipients.push({
          mode: cr.amount_mode,
          percentBps: cr.percent_bps,
          fixedAmountCents: cr.fixed_amount_cents == null ? null : asInt(cr.fixed_amount_cents),
        });
      }
      for (const [commissionId, entry] of grouped) {
        capByCommission.set(
          commissionId,
          checkCombinedCap({
            itemSubtotalCents: entry.itemSubtotalCents,
            discountCents: entry.discountCents,
            capBps: entry.capBps,
            recipients: entry.recipients,
          })
        );
      }
    }

    res.json({
      tab,
      count: rows.length,
      rows: rows.map((r) => {
        const cap = capByCommission.get(r.commission_id) ?? null;
        return {
          recipient_id: r.id,
          commission_number:
            r.commission_display_number == null
              ? null
              : `COM-${r.commission_display_number}`,
          state: r.state,
          is_open: isOpen(r.state),
          order_id: r.order_id,
          order_display_id: r.order_display_id == null ? null : String(r.order_display_id),
          order_document_number: r.order_document_number,
          display_name: r.display_name,
          customer_id: r.customer_id,
          qb_vendor_id: r.qb_vendor_id,
          percent_bps:
            r.amount_cents != null
              ? r.percent_bps
              : effectiveBps(asInt(r.base_cents), toRecipientAmount(r)) ?? r.percent_bps,
          amount_mode: r.amount_mode,
          amount_cents:
            r.amount_cents == null
              ? effectiveAmountCents(asInt(r.base_cents), toRecipientAmount(r))
              : asInt(r.amount_cents),
          amount_is_frozen: r.amount_cents != null,
          base_cents: asInt(r.base_cents),
          discount_bps: r.discount_bps,
          cap_bps: r.cap_bps,
          currency_code: r.currency_code,
          eligible_at: r.eligible_at,
          order_fully_paid: r.order_fully_paid,
          last_invoice_at: r.last_invoice_at,
          approval_ready_at: r.approval_ready_at,
          wait_days: r.wait_days,
          payout_method: r.payout_method,
          assigned_by: r.assigned_by_email ?? r.assigned_by,
          assigned_at: r.assigned_at,
          approved_by: r.approved_by_email ?? r.approved_by,
          approved_at: r.approved_at,
          settled_by: r.settled_by_email ?? r.settled_by,
          settled_at: r.settled_at,
          void_reason: r.void_reason,
          settlement: r.settlement_id
            ? {
                id: r.settlement_id,
                method: r.settlement_method,
                status: r.settlement_status,
                vendor_bill_id: r.vendor_bill_id,
                vendor_bill_number: r.vendor_bill_number,
                customer_payment_id: r.customer_payment_id,
                qb_check_txn_id: r.qb_check_txn_id,
                qb_payment_txn_id: r.qb_payment_txn_id,
                failure_reason: r.failure_reason,
              }
            : null,
          // Cap combinado de la comisión ENTERA (todas sus filas, sin filtro de
          // tab) — misma semántica que el GET de la orden. `cap` null se omite
          // en vez de mandar ceros: un cero diría "está bien".
          ...(cap
            ? {
                combined_bps: cap.combinedBps,
                cap_exceeded: !cap.ok && !cap.undeterminedFixed,
                cap_undetermined: cap.undeterminedFixed,
              }
            : {}),
        };
      }),
    });
  } catch (err) {
    console.error("[commissions] list failed:", err);
    res.status(500).json({ error: "Could not list commissions." });
  }
}
